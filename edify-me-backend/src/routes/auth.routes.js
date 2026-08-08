const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const prisma = require('../utils/db');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/email');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function genCode() {
  // 6-digit numeric code, e.g. "042917"
  return String(Math.floor(100000 + Math.random() * 900000));
}
function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}
function publicUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}
function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('token', token, {
    httpOnly: true,        // JS on the page can't read this — protects against XSS token theft
    sameSite: isProd ? 'none' : 'lax', // 'none' is required for cross-domain cookies (frontend/backend on different sites)
    secure: isProd,        // 'sameSite: none' requires 'secure: true', which requires HTTPS — true once deployed
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  });
}
function clearAuthCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('token', { httpOnly: true, sameSite: isProd ? 'none' : 'lax', secure: isProd });
}

/* ---------------- POST /api/auth/signup ---------------- */
router.post('/signup', async (req, res) => {
  try {
    const { firstName, lastName, email, username, password } = req.body;
    if (!firstName || !lastName || !email || !username || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: email, mode: 'insensitive' } },
          { username: { equals: username, mode: 'insensitive' } }
        ]
      }
    });
    if (existing) {
      return res.status(409).json({ error: 'Email or username already in use.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { firstName, lastName, email, username, passwordHash }
    });

    const code = genCode();
    await prisma.verificationCode.create({
      data: { userId: user.id, code, type: 'signup', expiresAt: new Date(Date.now() + 15 * 60 * 1000) }
    });

    // The account is already created at this point — an email hiccup should
    // NOT make signup look like it failed. Catch it separately, log it, and
    // let the user proceed to the verify screen either way; they can use
    // "Resend code" there if the email didn't actually arrive.
    try {
      await sendVerificationEmail(email, code);
    } catch (emailErr) {
      console.error('Signup succeeded but verification email failed to send:', emailErr.message);
    }

    res.status(201).json({ message: 'Account created. Check your email for a verification code.', userId: user.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong creating your account.' });
  }
});

/* ---------------- POST /api/auth/verify ---------------- */
router.post('/verify', async (req, res) => {
  try {
    const { userId, code } = req.body;
    const record = await prisma.verificationCode.findFirst({
      where: { userId, code, type: 'signup' },
      orderBy: { createdAt: 'desc' }
    });
    if (!record || record.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Code is invalid or expired.' });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { emailVerified: true }
    });
    await prisma.verificationCode.deleteMany({ where: { userId, type: 'signup' } });

    const token = signToken(user.id);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

/* ---------------- POST /api/auth/login ---------------- */
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body; // identifier = username OR email
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: identifier, mode: 'insensitive' } },
          { email: { equals: identifier, mode: 'insensitive' } }
        ]
      }
    });
    if (!user) return res.status(401).json({ error: 'No account found with that username/email.' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password.' });

    if (!user.emailVerified) {
      const code = genCode();
      await prisma.verificationCode.create({
        data: { userId: user.id, code, type: 'signup', expiresAt: new Date(Date.now() + 15 * 60 * 1000) }
      });
      try {
        await sendVerificationEmail(user.email, code);
      } catch (emailErr) {
        console.error('Login resend: verification email failed to send:', emailErr.message);
      }
      return res.status(403).json({ error: 'Please verify your email first. A new code was sent.', userId: user.id, needsVerification: true });
    }

    const token = signToken(user.id);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

/* ---------------- POST /api/auth/logout ---------------- */
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ message: 'Logged out.' });
});

/* ---------------- POST /api/auth/reset/request ---------------- */
router.post('/reset/request', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (!user) return res.status(404).json({ error: 'No account found with that email.' });

    const code = genCode();
    await prisma.verificationCode.create({
      data: { userId: user.id, code, type: 'reset', expiresAt: new Date(Date.now() + 15 * 60 * 1000) }
    });
    await sendPasswordResetEmail(email, code);

    res.json({ message: 'Reset code sent to your email.', userId: user.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start password reset.' });
  }
});

/* ---------------- POST /api/auth/reset/verify ---------------- */
router.post('/reset/verify', async (req, res) => {
  try {
    const { userId, code, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }
    const record = await prisma.verificationCode.findFirst({
      where: { userId, code, type: 'reset' },
      orderBy: { createdAt: 'desc' }
    });
    if (!record || record.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Code is invalid or expired.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await prisma.verificationCode.deleteMany({ where: { userId, type: 'reset' } });

    res.json({ message: 'Password reset successfully. Please log in.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Password reset failed.' });
  }
});

/* ---------------- POST /api/auth/change-password (logged-in user) ---------------- */
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const valid = await bcrypt.compare(currentPassword || '', user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: req.userId }, data: { passwordHash } });
    res.json({ message: 'Password updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update password.' });
  }
});

/* ---------------- POST /api/auth/resend-verification ---------------- */
router.post('/resend-verification', async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (user.emailVerified) return res.status(400).json({ error: 'This account is already verified — please log in.' });

    // Clear any old unused codes so only the newest one is valid.
    await prisma.verificationCode.deleteMany({ where: { userId, type: 'signup' } });

    const code = genCode();
    await prisma.verificationCode.create({
      data: { userId, code, type: 'signup', expiresAt: new Date(Date.now() + 15 * 60 * 1000) }
    });
    await sendVerificationEmail(user.email, code);

    res.json({ message: 'A new verification code has been sent to your email.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not resend verification code.' });
  }
});

module.exports = router;
