require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v22.0';

// Analytics Thresholds & Multipliers
const ENGAGEMENT_RATE_THRESHOLD = 3;
const HIGH_ENGAGEMENT_IMPACT_MULTIPLIER = 6;
const LOW_ENGAGEMENT_IMPACT_MULTIPLIER = 10;
const MIN_REEL_IMPACT = 8;
const REEL_IMPACT_MULTIPLIER = 0.6;
const POSTING_WINDOW_MULTIPLIER = 0.15;
const HASHTAG_REACH_BASE = 0.08;
const HASHTAG_REACH_PER_OCCURRENCE = 0.03;
const HASHTAG_MULTIPLIER_BASE = 1;
const HASHTAG_MULTIPLIER_PER_OCCURRENCE = 0.2;
const HASHTAG_MULTIPLIER_POSITION_STEP = 0.05;
const FALLBACK_HASHTAG_REACH_RATE = 0.1;
const FALLBACK_HASHTAG_MULTIPLIER = 1.1;
const VIRAL_SCORE_ENGAGEMENT_WEIGHT = 14;
const VIRAL_SCORE_REELS_WEIGHT = 0.35;
const VIRAL_SCORE_MIN = 10;
const VIRAL_SCORE_MAX = 99;
const RADAR_ENGAGEMENT_WEIGHT = 12;
const RADAR_ENGAGEMENT_MIN = 5;
const RADAR_ENGAGEMENT_MAX = 100;
const RADAR_CONSISTENCY_BASE = 40;
const RADAR_CONSISTENCY_POSTS_WEIGHT = 8;
const RADAR_CONSISTENCY_MIN = 20;
const RADAR_CONSISTENCY_MAX = 100;
const RADAR_SEO_HASHTAG_WEIGHT = 15;
const RADAR_SEO_MIN = 20;
const RADAR_SEO_MAX = 95;
const RADAR_VISUAL_BASE = 35;
const RADAR_VISUAL_MIN = 20;
const RADAR_VISUAL_MAX = 95;
const RADAR_GROWTH_OFFSET = 8;
const RADAR_GROWTH_MIN = 10;
const RADAR_GROWTH_MAX = 99;
const RADAR_RETENTION_BASE = 30;
const RADAR_RETENTION_INTERACTION_WEIGHT = 1000;
const RADAR_RETENTION_MIN = 10;
const RADAR_RETENTION_MAX = 95;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// Helper Utilities
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(date) {
  return date.toLocaleString('en-US', { month: 'short' });
}

function getRecentMonths(count = 6) {
  const now = new Date();
  const months = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  }
  return months;
}

function extractHashtags(mediaItems) {
  const counts = new Map();
  for (const post of mediaItems) {
    const caption = String(post.caption || '');
    const tags = caption.match(/#[A-Za-z0-9_]+/g) || [];
    for (const rawTag of tags) {
      const tag = rawTag.toLowerCase();
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
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
    { niche: 'Lifestyle', keys: ['lifestyle', 'daily', 'routine', 'life'] },
  ];

  for (const item of nicheMap) {
    if (item.keys.some((key) => text.includes(key))) {
      return item.niche;
    }
  }
  return 'Lifestyle';
}

function buildInsights({ reelPct, avgEr, topHour, followers, postCount }) {
  const erImpact = avgEr >= ENGAGEMENT_RATE_THRESHOLD
    ? `+${Math.round(avgEr * HIGH_ENGAGEMENT_IMPACT_MULTIPLIER)}% profile actions`
    : `+${Math.round(avgEr * LOW_ENGAGEMENT_IMPACT_MULTIPLIER)}% growth opportunity`;
  const reelImpact = `+${Math.max(MIN_REEL_IMPACT, Math.round(reelPct * REEL_IMPACT_MULTIPLIER))}% potential reach`;
  return [
    {
      title: 'Reel strategy signal',
      summary: `Reels currently represent ${reelPct}% of recent content, which is strongly tied to algorithmic discovery.`,
      impact: reelImpact,
      support: 'Derived from recent post mix',
    },
    {
      title: 'Current engagement baseline',
      summary: `Average engagement across the latest posts is ${avgEr}% based on likes + comments.`,
      impact: erImpact,
      support: 'Calculated from public media metrics',
    },
    {
      title: 'Best posting window',
      summary: `Your highest post activity is around ${topHour}:00 local profile time, useful for scheduling tests.`,
      impact: `~${Math.round(Math.max(1, postCount) * POSTING_WINDOW_MULTIPLIER)} extra engaged sessions`,
      support: 'Timestamp clustering from recent posts',
    },
    {
      title: 'Audience depth',
      summary: `With ${followers.toLocaleString()} followers, consistency in format and timing is key for sustained distribution.`,
      impact: '+Long-term retention potential',
      support: 'Follower base scale',
    },
  ];
}

function buildAnalyticsPayload(metaData) {
  const username = String(metaData.username || process.env.OWNER_USERNAME || 'instagram');
  const displayName = String(metaData.name || username);
  const followers = safeNumber(metaData.followers_count, 0);
  const following = safeNumber(metaData.follows_count, 0);
  const posts = safeNumber(metaData.media_count, 0);
  const profilePicture = String(metaData.profile_picture_url || '');

  const media = Array.isArray(metaData.media?.data) ? metaData.media.data : [];
  const recentMedia = media.slice(0, 20);
  const recent5 = recentMedia.slice(0, 5);
  const interactions = recent5.map((m) => safeNumber(m.like_count) + safeNumber(m.comments_count));
  const avgInteractions = interactions.length
    ? interactions.reduce((a, b) => a + b, 0) / interactions.length
    : 0;
  const engRate = followers > 0 ? Number(((avgInteractions / followers) * 100).toFixed(2)) : 0;

  const months = getRecentMonths(6);
  const labels = months.map(monthLabel);
  const bucket = new Map(months.map((d) => [monthKey(d), { posts: 0, interactions: 0 }]));
  const hourBucket = new Array(24).fill(0);

  for (const item of recentMedia) {
    const ts = item.timestamp ? new Date(item.timestamp) : null;
    if (ts && Number.isFinite(ts.getTime())) {
      const key = monthKey(new Date(ts.getFullYear(), ts.getMonth(), 1));
      if (bucket.has(key)) {
        const likes = safeNumber(item.like_count);
        const comments = safeNumber(item.comments_count);
        const entry = bucket.get(key);
        entry.posts += 1;
        entry.interactions += likes + comments;
      }
      hourBucket[ts.getHours()] += 1;
    }
  }

  const monthStats = months.map((d) => bucket.get(monthKey(d)) || { posts: 0, interactions: 0 });
  const postData = monthStats.map((m) => m.posts);
  const engData = monthStats.map((m) => {
    if (followers <= 0 || m.posts <= 0) return 0;
    return Number(((m.interactions / m.posts / followers) * 100).toFixed(2));
  });
  const reachData = monthStats.map((m) => m.interactions);

  let reelCount = 0;
  let carouselCount = 0;
  let photoCount = 0;
  for (const item of recentMedia) {
    const type = String(item.media_type || '').toUpperCase();
    if (type === 'VIDEO' || type === 'REEL') reelCount += 1;
    else if (type === 'CAROUSEL_ALBUM') carouselCount += 1;
    else photoCount += 1;
  }
  const totalCount = Math.max(1, reelCount + carouselCount + photoCount);
  const contentMix = {
    Reels: Math.round((reelCount / totalCount) * 100),
    Carousels: Math.round((carouselCount / totalCount) * 100),
    Photos: Math.max(0, 100 - Math.round((reelCount / totalCount) * 100) - Math.round((carouselCount / totalCount) * 100)),
  };

  const hashtagsTop = extractHashtags(recentMedia);
  const hashtags = hashtagsTop.length
    ? hashtagsTop.map(([tag, count], idx) => ({
        tag,
        reach: Math.round(Math.max(1, followers) * (HASHTAG_REACH_BASE + count * HASHTAG_REACH_PER_OCCURRENCE)),
        mult: Number((HASHTAG_MULTIPLIER_BASE + count * HASHTAG_MULTIPLIER_PER_OCCURRENCE + idx * HASHTAG_MULTIPLIER_POSITION_STEP).toFixed(1)),
      }))
    : [{ tag: '#instagram', reach: Math.round(followers * FALLBACK_HASHTAG_REACH_RATE), mult: FALLBACK_HASHTAG_MULTIPLIER }];

  const topHourIndex = hourBucket.reduce((best, value, index, arr) => (value > arr[best] ? index : best), 0);
  const nicheSource = `${metaData.biography || ''} ${recentMedia.map((m) => m.caption || '').join(' ')}`;
  const niche = inferNiche(nicheSource);
  const confidence = clamp(hashtagsTop.length ? 90 : 78, 70, 97);
  const viralScore = clamp(
    Math.round(engRate * VIRAL_SCORE_ENGAGEMENT_WEIGHT + contentMix.Reels * VIRAL_SCORE_REELS_WEIGHT),
    VIRAL_SCORE_MIN,
    VIRAL_SCORE_MAX
  );
  const radarScores = [
    clamp(Math.round(engRate * RADAR_ENGAGEMENT_WEIGHT), RADAR_ENGAGEMENT_MIN, RADAR_ENGAGEMENT_MAX),
    clamp(
      RADAR_CONSISTENCY_BASE + Math.round((postData.reduce((a, b) => a + b, 0) / Math.max(postData.length, 1)) * RADAR_CONSISTENCY_POSTS_WEIGHT),
      RADAR_CONSISTENCY_MIN,
      RADAR_CONSISTENCY_MAX
    ),
    clamp(hashtagsTop.length * RADAR_SEO_HASHTAG_WEIGHT, RADAR_SEO_MIN, RADAR_SEO_MAX),
    clamp(RADAR_VISUAL_BASE + contentMix.Photos, RADAR_VISUAL_MIN, RADAR_VISUAL_MAX),
    clamp(viralScore - RADAR_GROWTH_OFFSET, RADAR_GROWTH_MIN, RADAR_GROWTH_MAX),
    clamp(
      RADAR_RETENTION_BASE + Math.round((followers > 0 ? avgInteractions / followers : 0) * RADAR_RETENTION_INTERACTION_WEIGHT),
      RADAR_RETENTION_MIN,
      RADAR_RETENTION_MAX
    ),
  ];

  const insightsList = buildInsights({
    reelPct: contentMix.Reels,
    avgEr: engRate,
    topHour: topHourIndex,
    followers,
    postCount: recentMedia.length,
  });

  const recentPosts = recentMedia.slice(0, 10).map((m) => {
    const likes = safeNumber(m.like_count);
    const comments = safeNumber(m.comments_count);
    const type = String(m.media_type || '').toUpperCase();
    return {
      caption: String(m.caption || 'No caption').slice(0, 80),
      type: type === 'VIDEO' || type === 'REEL' ? 'reel' : type === 'CAROUSEL_ALBUM' ? 'carousel' : 'photo',
      likes,
      comments,
      er: followers > 0 ? Number((((likes + comments) / followers) * 100).toFixed(2)) : 0,
      permalink: String(m.permalink || ''),
    };
  });

  return {
    username: `@${username}`,
    displayName,
    niche,
    confidence,
    followers,
    following,
    posts,
    engRate,
    viralScore,
    avatarColor: '#7209b7',
    profilePicture,
    labels,
    engData,
    postData,
    reachData,
    contentMix,
    radarScores,
    insights: insightsList,
    hashtags,
    recentPosts,
    isRealData: true,
    ownerUsername: username.toLowerCase(),
  };
}

/**
 * FIXED: fetchMetaProfile now uses Business Discovery
 * This is the ONLY way to fetch profile data for a username.
 */
async function fetchMetaProfile(targetUsername) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const businessId = process.env.META_IG_BUSINESS_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!accessToken || !businessId) {
    throw new Error('Missing META_ACCESS_TOKEN or META_IG_BUSINESS_ID in server environment');
  }

  // Determine which user to analyze
  const username = targetUsername || process.env.OWNER_USERNAME || 'velixo_edits';

  // Build the Discovery Query
  const discoveryFields = `business_discovery.username(${username}){username,name,biography,followers_count,follows_count,media_count,profile_picture_url,media.limit(50){id,caption,media_type,like_count,comments_count,timestamp,permalink}}`;

  const params = new URLSearchParams({
    fields: discoveryFields,
    access_token: accessToken,
  });

  // Security Proof
  if (appSecret) {
    const appSecretProof = crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');
    params.set('appsecret_proof', appSecretProof);
  }

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${businessId}?${params.toString()}`;
  
  const response = await fetch(url);
  const json = await response.json();

  if (!response.ok || json?.error) {
    const msg = json?.error?.message || `Meta API error (${response.status})`;
    throw new Error(msg);
  }

  // The actual data is nested inside the discovery key
  if (!json.business_discovery) {
    throw new Error(`Account "${username}" could not be found via Business Discovery.`);
  }

  return json.business_discovery;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    metaConfigured: Boolean(process.env.META_ACCESS_TOKEN && process.env.META_IG_BUSINESS_ID),
    metaAppConfigured: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
    aiConfigured: Boolean(process.env.GEMINI_API_KEY),
  });
});

/**
 * FIXED: Route now correctly handles the ?username query parameter
 */
app.get('/api/instagram/profile', async (req, res) => {
  try {
    const targetUsername = req.query.username ? req.query.username.replace('@', '').trim() : null;
    const metaData = await fetchMetaProfile(targetUsername);
    const payload = buildAnalyticsPayload(metaData);
    res.json(payload);
  } catch (error) {
    console.error("Profile Fetch Error:", error.message);
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.post('/api/ai/generate', async (req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return res.status(503).json({ error: 'Missing GEMINI_API_KEY in server environment' });
  }

  const payload = req.body;
  const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError = 'Unknown AI error';

  for (const model of models) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiKey,
        },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (!response.ok) {
        lastError = json?.error?.message || `HTTP ${response.status}`;
        continue;
      }
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) {
        return res.json({ text, model });
      }
      lastError = 'No text generated by model';
    } catch (error) {
      lastError = String(error.message || error);
    }
  }

  return res.status(502).json({ error: lastError });
});

app.listen(PORT, () => {
  console.log(`GramIQ backend running at http://localhost:${PORT}`);
});
