const express = require('express');
const prisma = require('../utils/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function withCounts(u) {
  const { passwordHash, following, followers, ...rest } = u;
  return {
    ...rest,
    followingCount: following?.length ?? u._count?.following ?? 0,
    followersCount: followers?.length ?? u._count?.followers ?? 0
  };
}

/* ---------------- GET /api/users/me ---------------- */
router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    include: { _count: { select: { following: true, followers: true } }, following: true }
  });
  const followingIds = user.following.map(f => f.followingId);
  res.json({ ...withCounts(user), followingIds });
});

/* ---------------- GET /api/users/me/following (full profiles) ---------------- */
router.get('/me/following', requireAuth, async (req, res) => {
  const rows = await prisma.follow.findMany({
    where: { followerId: req.userId },
    include: { following: { include: { _count: { select: { following: true, followers: true } } } } }
  });
  res.json(rows.map(r => withCounts(r.following)));
});

/* ---------------- GET /api/users/me/followers (full profiles) ---------------- */
router.get('/me/followers', requireAuth, async (req, res) => {
  const rows = await prisma.follow.findMany({
    where: { followingId: req.userId },
    include: { follower: { include: { _count: { select: { following: true, followers: true } } } } }
  });
  res.json(rows.map(r => withCounts(r.follower)));
});

/* ---------------- GET /api/users/:username ---------------- */
router.get('/:username', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { username: req.params.username },
    include: { _count: { select: { following: true, followers: true } } }
  });
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json(withCounts(user));
});

/* ---------------- GET /api/users/:id/following-status ---------------- */
router.get('/:id/following-status', requireAuth, async (req, res) => {
  const follow = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId: req.userId, followingId: req.params.id } }
  });
  res.json({ following: !!follow });
});

/* ---------------- POST /api/users/:id/follow ---------------- */
router.post('/:id/follow', requireAuth, async (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.userId) return res.status(400).json({ error: "You can't follow yourself." });

  try {
    await prisma.follow.create({ data: { followerId: req.userId, followingId: targetId } });
    res.json({ following: true });
  } catch (err) {
    // unique constraint => already following
    res.status(409).json({ error: 'Already following this user.' });
  }
});

/* ---------------- DELETE /api/users/:id/follow (unfollow) ---------------- */
router.delete('/:id/follow', requireAuth, async (req, res) => {
  await prisma.follow.deleteMany({ where: { followerId: req.userId, followingId: req.params.id } });
  res.json({ following: false });
});

/* ---------------- GET /api/users/suggestions/list -----------------
   Ranks non-followed users by mutual-following overlap + overall popularity. */
router.get('/suggestions/list', requireAuth, async (req, res) => {
  const me = await prisma.user.findUnique({
    where: { id: req.userId },
    include: { following: true }
  });
  const followingIds = me.following.map(f => f.followingId);

  const candidates = await prisma.user.findMany({
    where: { id: { notIn: [...followingIds, req.userId] } },
    include: {
      _count: { select: { followers: true } },
      followers: { where: { followerId: { in: followingIds } } } // mutuals
    },
    take: 50
  });

  const scored = candidates
    .map(u => ({
      user: withCounts(u),
      score: u.followers.length * 10 + u._count.followers
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(s => s.user);

  res.json(scored);
});

/* ---------------- PATCH /api/users/me (update first/last name) ---------------- */
router.patch('/me', requireAuth, async (req, res) => {
  const { firstName, lastName } = req.body;
  if (!firstName?.trim() || !lastName?.trim()) {
    return res.status(400).json({ error: 'First and last name are required.' });
  }
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { firstName: firstName.trim(), lastName: lastName.trim() },
    include: { _count: { select: { following: true, followers: true } }, following: true }
  });
  const followingIds = user.following.map(f => f.followingId);
  res.json({ ...withCounts(user), followingIds });
});

module.exports = router;
