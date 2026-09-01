require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = Number(process.env.PORT || 3000);
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v22.0';

const ALLOWED_ORIGINS = String(process.env.CORS_ORIGIN || '').split(',').map(v => v.trim()).filter(Boolean);
const LOCAL_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || (process.env.NODE_ENV !== 'production' && LOCAL_ORIGINS.has(origin))) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '64kb' }));
// The current repository keeps the dashboard entrypoint at the project root.
// Keep serving the root until the frontend is migrated completely into /public.
app.use(express.static(path.join(__dirname), { dotfiles: 'deny', index: 'index.html' }));

const rateBuckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) { rateBuckets.set(key, { startedAt: now, count: 1 }); return next(); }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (now - bucket.startedAt)) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  };
}
const profileLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function safeNumber(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function monthKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
function monthLabel(date) { return date.toLocaleString('en-US', { month: 'short' }); }
function getRecentMonths(count = 6) { const now = new Date(); const months = []; for (let i = count - 1; i >= 0; i -= 1) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1)); return months; }
function extractHashtags(mediaItems) {
  const counts = new Map();
  for (const post of mediaItems) {
    const tags = String(post.caption || '').match(/#[A-Za-z0-9_]+/g) || [];
    for (const rawTag of tags) { const tag = rawTag.toLowerCase(); counts.set(tag, (counts.get(tag) || 0) + 1); }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
}
function inferNiche(profileText) {
  const text = profileText.toLowerCase();
  const nicheMap = [
    { niche: 'Fitness', keys: ['fitness', 'gym', 'workout', 'nutrition', 'training'] },
    { niche: 'Food & Cooking', keys: ['food', 'recipe', 'cooking', 'chef', 'kitchen'] },
    { niche: 'Travel', keys: ['travel', 'trip', 'adventure', 'destination'] },
    { niche: 'Tech & Gaming', keys: ['tech', 'gaming', 'game', 'ai', 'software', 'code'] },
    { niche: 'Business', keys: ['business', 'startup', 'marketing', 'finance', 'entrepreneur'] },
    { niche: 'Art & Creative', keys: ['art', 'creative', 'design', 'photo', 'cinematic', 'edit'] },
    { niche: 'Entertainment', keys: ['comedy', 'entertainment', 'funny', 'meme'] },
    { niche: 'Education', keys: ['learn', 'education', 'teach', 'tips', 'facts'] },
    { niche: 'Fashion', keys: ['fashion', 'style', 'outfit', 'ootd'] },
    { niche: 'Lifestyle', keys: ['lifestyle', 'daily', 'routine', 'life'] }
  ];
  for (const item of nicheMap) if (item.keys.some(key => text.includes(key))) return item.niche;
  return 'Lifestyle';
}
function buildInsights({ reelPct, avgEr, topHour, followers }) {
  return [
    { title: 'Reel strategy signal', summary: `Reels represent ${reelPct}% of recent content. Use this as a format-mix signal, not a guaranteed reach advantage.`, impact: `${reelPct}% of recent posts`, support: 'Derived from recent post mix' },
    { title: 'Current engagement baseline', summary: `Average engagement across the latest posts is ${avgEr}% based on likes + comments.`, impact: avgEr >= 3 ? 'Above the 3% reference benchmark' : 'Below the 3% reference benchmark', support: 'Calculated from public media metrics' },
    { title: 'Most-used posting hour', summary: `Recent posts cluster most often around ${topHour}:00 in the server-observed timestamp timezone.`, impact: 'Test this window against alternatives', support: 'Timestamp frequency from recent posts' },
    { title: 'Audience depth', summary: `The account has ${followers.toLocaleString()} followers. Use engagement and posting consistency to evaluate audience activity.`, impact: 'Track future snapshots for growth', support: 'Current follower count' }
  ];
}
function buildAnalyticsPayload(metaData) {
  const username = String(metaData.username || process.env.OWNER_USERNAME || 'instagram');
  const displayName = String(metaData.name || username);
  const followers = safeNumber(metaData.followers_count);
  const following = safeNumber(metaData.follows_count);
  const posts = safeNumber(metaData.media_count);
  const profilePicture = String(metaData.profile_picture_url || '');
  const recentMedia = Array.isArray(metaData.media?.data) ? metaData.media.data.slice(0, 20) : [];
  const recent5 = recentMedia.slice(0, 5);
  const avgInteractions = recent5.length ? recent5.reduce((sum, m) => sum + safeNumber(m.like_count) + safeNumber(m.comments_count), 0) / recent5.length : 0;
  const engRate = followers > 0 ? Number(((avgInteractions / followers) * 100).toFixed(2)) : 0;
  const months = getRecentMonths(6);
  const bucket = new Map(months.map(d => [monthKey(d), { posts: 0, interactions: 0 }]));
  const hourBucket = new Array(24).fill(0);
  for (const item of recentMedia) {
    const ts = item.timestamp ? new Date(item.timestamp) : null;
    if (!ts || !Number.isFinite(ts.getTime())) continue;
    const entry = bucket.get(monthKey(new Date(ts.getFullYear(), ts.getMonth(), 1)));
    if (entry) { entry.posts += 1; entry.interactions += safeNumber(item.like_count) + safeNumber(item.comments_count); }
    hourBucket[ts.getHours()] += 1;
  }
  const monthStats = months.map(d => bucket.get(monthKey(d)) || { posts: 0, interactions: 0 });
  const postData = monthStats.map(m => m.posts);
  const engData = monthStats.map(m => followers > 0 && m.posts > 0 ? Number(((m.interactions / m.posts / followers) * 100).toFixed(2)) : 0);
  const interactionsData = monthStats.map(m => m.interactions);
  let reelCount = 0, carouselCount = 0, photoCount = 0;
  for (const item of recentMedia) { const type = String(item.media_type || '').toUpperCase(); if (type === 'VIDEO' || type === 'REEL') reelCount += 1; else if (type === 'CAROUSEL_ALBUM') carouselCount += 1; else photoCount += 1; }
  const totalCount = Math.max(1, reelCount + carouselCount + photoCount);
  const contentMix = { Reels: Math.round(reelCount / totalCount * 100), Carousels: Math.round(carouselCount / totalCount * 100), Photos: Math.max(0, 100 - Math.round(reelCount / totalCount * 100) - Math.round(carouselCount / totalCount * 100)) };
  const hashtagsTop = extractHashtags(recentMedia);
  const hashtags = hashtagsTop.map(([tag, count]) => ({ tag, count }));
  const topHour = hourBucket.reduce((best, value, index, arr) => value > arr[best] ? index : best, 0);
  const niche = inferNiche(`${metaData.biography || ''} ${recentMedia.map(m => m.caption || '').join(' ')}`);
  const confidence = clamp(hashtagsTop.length ? 90 : 78, 70, 97);
  const contentScore = clamp(Math.round(engRate * 14 + contentMix.Reels * 0.35), 10, 99);
  const avgPostsPerMonth = postData.reduce((a, b) => a + b, 0) / Math.max(postData.length, 1);
  const hashtagUsage = hashtagsTop.length;
  const radarScores = [clamp(Math.round(engRate * 12), 5, 100), clamp(Math.round(40 + avgPostsPerMonth * 8), 20, 100), clamp(hashtagUsage * 15, 20, 95), clamp(35 + contentMix.Photos, 20, 95), clamp(contentScore - 8, 10, 99), clamp(30 + Math.round((followers > 0 ? avgInteractions / followers : 0) * 1000), 10, 95)];
  const recentPosts = recentMedia.slice(0, 10).map(m => { const likes = safeNumber(m.like_count); const comments = safeNumber(m.comments_count); const type = String(m.media_type || '').toUpperCase(); return { caption: String(m.caption || 'No caption').slice(0, 80), type: type === 'VIDEO' || type === 'REEL' ? 'reel' : type === 'CAROUSEL_ALBUM' ? 'carousel' : 'photo', likes, comments, er: followers > 0 ? Number((((likes + comments) / followers) * 100).toFixed(2)) : 0, permalink: String(m.permalink || '') }; });
  return {
    username: `@${username}`, displayName, niche, confidence, followers, following, posts, engRate,
    viralScore: contentScore, avatarColor: '#7209b7', profilePicture,
    labels: months.map(monthLabel), engData, postData, interactionsData, contentMix, radarScores,
    insights: buildInsights({ reelPct: contentMix.Reels, avgEr: engRate, topHour, followers }),
    hashtags, recentPosts, isRealData: true,
    isOwner: username.toLowerCase() === String(process.env.OWNER_USERNAME || '').trim().toLowerCase(),
    scoreMethodology: 'Internal GramIQ heuristic based on recent engagement and content mix; not an Instagram metric.'
  };
}
async function fetchMetaProfile(targetUsername) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const businessId = process.env.META_IG_BUSINESS_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!accessToken || !businessId) throw new Error('Missing META_ACCESS_TOKEN or META_IG_BUSINESS_ID in server environment');
  const username = targetUsername || process.env.OWNER_USERNAME || 'velixo_edits';
  const fields = `business_discovery.username(${username}){username,name,biography,followers_count,follows_count,media_count,profile_picture_url,media.limit(50){id,caption,media_type,like_count,comments_count,timestamp,permalink}}`;
  const params = new URLSearchParams({ fields, access_token: accessToken });
  if (appSecret) params.set('appsecret_proof', crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex'));
  const response = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${businessId}?${params.toString()}`);
  const json = await response.json();
  if (!response.ok || json?.error) throw new Error(json?.error?.message || `Meta API error (${response.status})`);
  if (!json.business_discovery) throw new Error(`Account "${username}" could not be found via Business Discovery.`);
  return json.business_discovery;
}
app.get('/api/health', (_req, res) => res.json({ ok: true, metaConfigured: Boolean(process.env.META_ACCESS_TOKEN && process.env.META_IG_BUSINESS_ID), metaAppConfigured: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET), aiConfigured: Boolean(process.env.GEMINI_API_KEY) }));
app.get('/api/instagram/profile', profileLimiter, async (req, res) => {
  try {
    const rawUsername = req.query.username ? String(req.query.username).trim().replace(/^@/, '') : '';
    if (rawUsername && !/^[A-Za-z0-9._]{1,30}$/.test(rawUsername)) return res.status(400).json({ error: 'Invalid Instagram username.' });
    res.json(buildAnalyticsPayload(await fetchMetaProfile(rawUsername || null)));
  } catch (error) { console.error('Profile Fetch Error:', error.message); res.status(502).json({ error: String(error.message || error) }); }
});
app.post('/api/ai/generate', aiLimiter, async (req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(503).json({ error: 'AI is not configured on the server.' });
  const payload = req.body && typeof req.body === 'object' ? req.body : null;
  if (!payload || !Array.isArray(payload.contents) || payload.contents.length > 30) return res.status(400).json({ error: 'Invalid AI request.' });
  const contents = payload.contents.map(item => ({ role: item?.role === 'model' ? 'model' : 'user', parts: Array.isArray(item?.parts) ? item.parts.slice(0, 4).map(part => ({ text: String(part?.text || '').slice(0, 4000) })) : [] })).filter(item => item.parts.some(part => part.text));
  if (!contents.length) return res.status(400).json({ error: 'AI request contains no usable text.' });
  const cleanPayload = { contents, generationConfig: { maxOutputTokens: Math.min(Number(payload.generationConfig?.maxOutputTokens) || 400, 600) } };
  if (payload.system_instruction?.parts?.[0]?.text) cleanPayload.system_instruction = { parts: [{ text: String(payload.system_instruction.parts[0].text).slice(0, 8000) }] };
  let lastError = 'Unknown AI error';
  for (const model of ['gemini-2.0-flash', 'gemini-1.5-flash']) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey }, body: JSON.stringify(cleanPayload) });
      const json = await response.json();
      if (!response.ok) { lastError = json?.error?.message || `HTTP ${response.status}`; continue; }
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) return res.json({ text, model });
      lastError = 'No text generated by model';
    } catch (error) { lastError = String(error.message || error); }
  }
  return res.status(502).json({ error: lastError });
});
app.use((error, _req, res, _next) => { console.error('Request error:', error.message); if (!res.headersSent) res.status(400).json({ error: 'Request could not be processed.' }); });
app.listen(PORT, () => console.log(`GramIQ backend running at http://localhost:${PORT}`));
