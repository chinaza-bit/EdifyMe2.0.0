const express = require('express');
const prisma = require('../utils/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const TAGS = ['faith', 'worship', 'bible-study', 'testimony', 'youth', 'prayer', 'fellowship', 'music'];
const REPORT_HIDE_THRESHOLD = 3;

function randomTags() {
  const n = 1 + Math.floor(Math.random() * 2);
  const set = new Set();
  while (set.size < n) set.add(TAGS[Math.floor(Math.random() * TAGS.length)]);
  return [...set];
}
function serializePost(p, viewerId) {
  return {
    id: p.id,
    html: p.html,
    imageUrl: p.imageUrl,
    musicUrl: p.musicUrl,
    type: p.type,
    title: p.title,
    tags: p.tags,
    createdAt: p.createdAt,
    author: { id: p.author.id, firstName: p.author.firstName, lastName: p.author.lastName, username: p.author.username },
    likeCount: p.likes.length,
    likedByMe: p.likes.some(l => l.userId === viewerId),
    reportCount: p.reports.length,
    reportedByMe: p.reports.some(r => r.userId === viewerId)
  };
}

/* ---------------- GET /api/posts/feed -----------------
   Ranking: following-authored posts are boosted heavily and ordered by
   recency + how much the viewer engages with that author; non-followed
   posts are ranked mostly by recency as a secondary tier. Posts with
   3+ reports are excluded (auto-hidden pending review). */
router.get('/feed', requireAuth, async (req, res) => {
  const viewerId = req.userId;
  const me = await prisma.user.findUnique({ where: { id: viewerId }, include: { following: true } });
  const followingIds = new Set(me.following.map(f => f.followingId));

  const posts = await prisma.post.findMany({
    where: { type: 'post' },
    include: { author: true, likes: true, reports: true },
    orderBy: { createdAt: 'desc' },
    take: 200
  });

  const visible = posts.filter(p => p.reports.length < REPORT_HIDE_THRESHOLD);

  const scored = visible.map(p => {
    const isFollowing = followingIds.has(p.authorId);
    const ageHours = (Date.now() - new Date(p.createdAt).getTime()) / 3600000;
    const recencyScore = Math.max(0, 240 - ageHours);
    const engagement = p.likes.some(l => l.userId === viewerId) ? 40 : 0;
    let score = recencyScore + engagement;
    score += isFollowing ? 1000 : 0;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);

  res.json(scored.map(s => serializePost(s.p, viewerId)));
});

/* ---------------- GET /api/posts/suggested -----------------
   Posts from people the viewer doesn't follow, ranked by tag overlap
   with posts the viewer has already liked. */
router.get('/suggested', requireAuth, async (req, res) => {
  const viewerId = req.userId;
  const me = await prisma.user.findUnique({ where: { id: viewerId }, include: { following: true } });
  const followingIds = new Set(me.following.map(f => f.followingId));

  const likedPosts = await prisma.post.findMany({ where: { likes: { some: { userId: viewerId } } } });
  const likedTags = new Set(likedPosts.flatMap(p => p.tags));

  const candidates = await prisma.post.findMany({
    where: { type: 'post', authorId: { notIn: [...followingIds, viewerId] } },
    include: { author: true, likes: true, reports: true },
    take: 100
  });

  const scored = candidates
    .filter(p => p.reports.length < REPORT_HIDE_THRESHOLD)
    .map(p => ({ p, score: p.tags.filter(t => likedTags.has(t)).length * 10 + p.likes.length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  res.json(scored.map(s => serializePost(s.p, viewerId)));
});

/* ---------------- GET /api/posts/mine ---------------- */
router.get('/mine', requireAuth, async (req, res) => {
  const posts = await prisma.post.findMany({
    where: { authorId: req.userId, type: 'post' },
    include: { author: true, likes: true, reports: true },
    orderBy: { createdAt: 'desc' }
  });
  res.json(posts.map(p => serializePost(p, req.userId)));
});

/* ---------------- POST /api/posts (create a post) ---------------- */
router.post('/', requireAuth, async (req, res) => {
  const { html, imageUrl, musicUrl } = req.body;
  if (!html && !imageUrl) return res.status(400).json({ error: 'Post needs text or an image.' });

  const post = await prisma.post.create({
    data: { authorId: req.userId, html: html || '', imageUrl, musicUrl, type: 'post', tags: randomTags() },
    include: { author: true, likes: true, reports: true }
  });
  res.status(201).json(serializePost(post, req.userId));
});

/* ---------------- DELETE /api/posts/:id ---------------- */
router.delete('/:id', requireAuth, async (req, res) => {
  const post = await prisma.post.findUnique({ where: { id: req.params.id } });
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (post.authorId !== req.userId) return res.status(403).json({ error: 'You can only delete your own posts.' });
  await prisma.post.delete({ where: { id: req.params.id } });
  res.json({ deleted: true });
});

/* ---------------- POST /api/posts/:id/like (toggle) ---------------- */
router.post('/:id/like', requireAuth, async (req, res) => {
  const existing = await prisma.like.findUnique({
    where: { userId_postId: { userId: req.userId, postId: req.params.id } }
  });
  if (existing) {
    await prisma.like.delete({ where: { id: existing.id } });
    return res.json({ liked: false });
  }
  await prisma.like.create({ data: { userId: req.userId, postId: req.params.id } });
  res.json({ liked: true });
});

/* ---------------- POST /api/posts/:id/report ---------------- */
router.post('/:id/report', requireAuth, async (req, res) => {
  const { reason } = req.body;
  try {
    await prisma.report.create({ data: { userId: req.userId, postId: req.params.id, reason: reason || 'unspecified' } });
    res.json({ reported: true });
  } catch (err) {
    res.status(409).json({ error: 'You already reported this post.' });
  }
});

/* ---------------- ANNOUNCEMENTS ---------------- */
router.get('/announcements/list', requireAuth, async (req, res) => {
  const items = await prisma.post.findMany({
    where: { type: 'announcement' },
    include: { author: true, likes: true, reports: true },
    orderBy: { createdAt: 'desc' }
  });
  res.json(items.filter(p => p.reports.length < REPORT_HIDE_THRESHOLD).map(p => serializePost(p, req.userId)));
});

router.post('/announcements', requireAuth, async (req, res) => {
  const { title, html, imageUrl } = req.body;
  if (!title || !html) return res.status(400).json({ error: 'Title and details are required.' });
  const post = await prisma.post.create({
    data: { authorId: req.userId, title, html, imageUrl, type: 'announcement', tags: [] },
    include: { author: true, likes: true, reports: true }
  });
  res.status(201).json(serializePost(post, req.userId));
});

module.exports = router;
