const nodemailer = require('nodemailer');

// Brevo's free tier lets you send to ANY recipient as soon as your single
// "from" address is verified in the Brevo dashboard (Senders, Domains &
// Dedicated IPs > Senders > Add Sender) — unlike Resend's sandbox, it does
// NOT require you to own/verify a domain. 300 emails/day, no expiration.
const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false, // STARTTLS on port 587
  auth: {
    user: process.env.BREVO_SMTP_USER, // your Brevo login email
    pass: process.env.BREVO_SMTP_KEY   // the SMTP Key from Brevo's SMTP & API settings (NOT your account password)
  }
});

async function sendAndCheck(payload) {
  try {
    const info = await transporter.sendMail(payload);
    console.log(`Email sent via Brevo, messageId=${info.messageId}`);
    return info;
  } catch (err) {
    console.error('Brevo send failed:', err.message);
    throw new Error(`Email delivery failed: ${err.message}`);
  }
}

async function sendVerificationEmail(toEmail, code) {
  return sendAndCheck({
    from: process.env.EMAIL_FROM,
    to: toEmail,
    subject: 'Verify your Edify Me account',
    html: `<p>Welcome to Edify Me! Your verification code is:</p>
           <h2 style="letter-spacing:4px">${code}</h2>
           <p>This code expires in 15 minutes.</p>`
  });
}

async function sendPasswordResetEmail(toEmail, code) {
  return sendAndCheck({
    from: process.env.EMAIL_FROM,
    to: toEmail,
    subject: 'Reset your Edify Me password',
    html: `<p>Someone requested a password reset for this account. Your code is:</p>
           <h2 style="letter-spacing:4px">${code}</h2>
           <p>If this wasn't you, you can safely ignore this email. This code expires in 15 minutes.</p>`
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
