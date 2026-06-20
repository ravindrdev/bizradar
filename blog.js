/* blog.js — Phase 1 file-based blog.

   One markdown file per post in content/blog/. Front-matter (title, date,
   author, description, slug, cover) is parsed by gray-matter; the body is
   rendered by markdown-it and sanitized. The module mirrors seoPages.js:
   register(app) wires GET-only routes, pages are SSR'd once and LRU-cached,
   and the site's exact nav/footer/CSS are reused so the blog is visually
   identical to the rest of growthim.com.

   Registered in server.js AFTER seoPages and BEFORE express.static, so
   /blog and /blog/:slug take precedence over the static dir. No DB, no auth,
   no external APIs. Fail-soft: if content/blog is missing or empty, /blog
   renders an empty state and nothing else is affected.

   PHASE 2 SEAM: all post loading is isolated in loadPosts(), which returns a
   fixed post shape. A future admin editor can write to that same shape (a new
   markdown file or a DB row) and call the exported reload() to refresh, with
   no change to rendering or routing. */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const MarkdownIt = require('markdown-it');
const sanitizeHtml = require('sanitize-html');

// Reuse the exact site chrome + helpers from seoPages (already loaded by the
// time server.js requires this module). No duplicated styles, no require cycle
// (seoPages does not require blog).
const { navHtml, footerHtml, CSS, esc, BASE, GA } = require('./seoPages');

const BLOG_DIR = path.join(__dirname, 'content', 'blog');

// typographer:false is deliberate — it stops markdown-it from auto-converting
// "--" into an em dash, honoring the site-wide no-em-dash rule. html:false
// means any raw HTML in a post is escaped, not rendered (safe by default).
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

// Sanitizer allowlist — covers exactly what the post template supports
// (headings, bold/italic, links, images placed anywhere, lists, quotes, code,
// simple tables). Anything else is stripped. This also makes Phase 2 safe by
// default, when post bodies may come from an admin form.
const SANITIZE = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'ul', 'ol', 'li', 'blockquote',
    'strong', 'em', 'b', 'i', 'u', 's', 'code', 'pre', 'img', 'hr', 'br',
    'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'span', 'sup', 'sub',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
    '*': ['id'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    // Lazy-load + async-decode every image for fast, mobile-friendly pages.
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy', decoding: 'async' } }),
    // Open external links in a new tab safely; internal links stay in-tab.
    a: (tagName, attribs) => {
      const a = { ...attribs };
      if (a.href && /^https?:\/\//i.test(a.href) && !/growthim\.com/i.test(a.href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      return { tagName, attribs: a };
    },
  },
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function cleanSlug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function plainText(html) {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatDate(d) {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function isPostFile(f) {
  return /\.md$/i.test(f) && !/^(TEMPLATE|README)\.md$/i.test(f) && !f.startsWith('_') && !f.startsWith('.');
}

// ── Data layer (the Phase 2 seam) ────────────────────────────────────
// Returns an array of post objects, newest first, each with a fixed shape:
//   { slug, title, date, dateISO, dateDisplay, author, description, excerpt,
//     cover, html, readingMins }
function loadPosts() {
  let files;
  try {
    files = fs.readdirSync(BLOG_DIR);
  } catch (e) {
    console.error('[blog] content/blog not found — no posts loaded:', e.message);
    return [];
  }
  const posts = [];
  for (const file of files) {
    if (!isPostFile(file)) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(BLOG_DIR, file), 'utf8');
    } catch (e) {
      console.error('[blog] cannot read', file, e.message);
      continue;
    }
    let fm, content;
    try {
      const parsed = matter(raw);
      fm = parsed.data || {};
      content = parsed.content || '';
    } catch (e) {
      console.error('[blog] front-matter parse failed for', file, e.message);
      continue;
    }
    const title = String(fm.title || '').trim();
    if (!title) { console.warn('[blog] skipping', file, '(missing title)'); continue; }
    const slug = cleanSlug(fm.slug || file.replace(/\.md$/i, ''));
    if (!slug) { console.warn('[blog] skipping', file, '(empty slug)'); continue; }

    const parsedDate = fm.date ? new Date(fm.date) : null;
    const date = (parsedDate && !isNaN(parsedDate.getTime())) ? parsedDate : new Date();
    const author = String(fm.author || 'GrowthIM Team').trim();

    const html = sanitizeHtml(md.render(content), SANITIZE);
    const text = plainText(html);
    const fmDesc = String(fm.description || '').trim();
    const description = fmDesc || (text.slice(0, 155).trim() + (text.length > 155 ? '...' : ''));
    const excerpt = fmDesc || (text.slice(0, 200).trim() + (text.length > 200 ? '...' : ''));
    const cover = String(fm.cover || '').trim() || null;
    // pinned: true in front-matter keeps a post at the top of the list.
    const pinned = fm.pinned === true || /^(true|yes|1)$/i.test(String(fm.pinned == null ? '' : fm.pinned).trim());
    const words = text ? text.split(/\s+/).length : 0;
    const readingMins = Math.max(1, Math.round(words / 200));

    posts.push({
      slug, title, date,
      dateISO: date.toISOString().split('T')[0],
      dateDisplay: formatDate(date),
      author, description, excerpt, cover, html, readingMins, pinned,
    });
  }
  // Pinned posts first (newest-first among them), then everyone else newest-first.
  posts.sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.date - a.date) || a.title.localeCompare(b.title));

  // De-duplicate slugs (first wins after the newest-first sort).
  const seen = new Set();
  const unique = [];
  for (const p of posts) {
    if (seen.has(p.slug)) { console.warn('[blog] duplicate slug, ignoring later post:', p.slug); continue; }
    seen.add(p.slug);
    unique.push(p);
  }
  return unique;
}

// In-memory state, (re)built by reload(). On Railway each deploy restarts the
// process, so reload() at register() time is all Phase 1 needs. Phase 2 calls
// reload() after publishing to refresh without a restart.
let POSTS = [];
let BY_SLUG = new Map();

// Blog responses use a SHORT browser/CDN cache (5 minutes), not the 24h cache
// the static SEO pages use, so a newly published or edited post shows up quickly
// for visitors instead of being pinned for a day. Rendered HTML is memoized
// in-process for speed; reload() clears it so a restart always serves fresh.
const renderCache = new Map();
function send(res, type, key, producer) {
  let out = renderCache.get(key);
  if (out === undefined) { out = producer(); renderCache.set(key, out); }
  res.set('Content-Type', type);
  res.set('Cache-Control', 'public, max-age=300');
  res.send(out);
}

function reload() {
  POSTS = loadPosts();
  BY_SLUG = new Map(POSTS.map((p) => [p.slug, p]));
  renderCache.clear();
  return POSTS.length;
}

// ── Blog-specific styles (appended to the shared site CSS) ───────────
const BLOG_CSS = `
.post-body{font-size:17px;line-height:1.75;color:var(--text);}
.post-body h2{font-size:24px;font-weight:700;color:var(--navy);margin:36px 0 12px;letter-spacing:-0.01em;line-height:1.25;}
.post-body h3{font-size:19px;font-weight:700;color:var(--navy);margin:28px 0 8px;}
.post-body p{margin:0 0 18px;}
.post-body ul,.post-body ol{margin:0 0 18px;padding-left:24px;}
.post-body li{margin:7px 0;}
.post-body img{max-width:100%;height:auto;border-radius:10px;margin:24px 0;display:block;border:1px solid var(--gray-200);}
.post-body a{color:var(--blue);text-decoration:underline;}
.post-body blockquote{margin:20px 0;padding:10px 18px;border-left:3px solid var(--blue);background:var(--gray-100);border-radius:6px;}
.post-body blockquote p{margin:0;}
.post-body code{background:var(--gray-100);border:1px solid var(--gray-200);border-radius:4px;padding:1px 6px;font-size:14px;}
.post-body pre{background:var(--navy);color:#E2E8F0;border-radius:10px;padding:16px 18px;overflow:auto;margin:20px 0;}
.post-body pre code{background:none;border:none;color:inherit;padding:0;}
.post-body table{border-collapse:collapse;width:100%;margin:20px 0;font-size:15px;}
.post-body th,.post-body td{border:1px solid var(--gray-200);padding:8px 12px;text-align:left;}
.post-body th{background:var(--gray-100);font-weight:700;}
.post-meta{font-size:14px;color:var(--muted);margin:0;font-weight:500;}
.post-lead{font-size:19px;line-height:1.6;color:var(--text);font-weight:600;margin:0 0 26px;padding-bottom:22px;border-bottom:1px solid var(--gray-200);}
.post-foot{margin-top:40px;padding-top:24px;border-top:1px solid var(--gray-200);}
.blog-list{margin:8px 0 0;}
.blog-item{padding:26px 0;border-bottom:1px solid var(--gray-200);}
.blog-item:first-child{padding-top:6px;}
.blog-item h2{font-size:24px;font-weight:700;margin:0 0 6px;letter-spacing:-0.01em;line-height:1.25;}
.blog-item h2 a{color:var(--navy);text-decoration:none;}
.blog-item h2 a:hover{color:var(--blue);}
.blog-item .meta{font-size:13px;color:var(--muted);margin:0 0 10px;}
.blog-item .preview{font-size:16px;color:var(--text);margin:0 0 10px;}
.blog-item .more{font-size:14px;font-weight:600;}
.blog-badge{display:inline-block;background:var(--blue);color:#fff;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:3px 11px;border-radius:999px;margin:0 0 9px;}
`;

function blogShell({ title, desc, canonical, ogType, ogImage, articleMeta, ldBlocks, body }) {
  const img = ogImage || (BASE + '/og-image.png');
  return `<!doctype html>
<html lang="en">
<head>
${GA}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="${ogType || 'website'}">
<meta property="og:site_name" content="GrowthIM">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${img}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${img}">
${articleMeta || ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
${ldBlocks.map((o) => '<script type="application/ld+json">' + JSON.stringify(o) + '</script>').join('\n')}
<style>${CSS}${BLOG_CSS}</style>
</head>
<body>
${navHtml()}
${body}
${footerHtml()}
</body>
</html>`;
}

// ── Single post ──────────────────────────────────────────────────────
function renderPost(post, posts) {
  const canonical = `${BASE}/blog/${post.slug}`;
  const ogImage = post.cover
    ? (/^https?:\/\//i.test(post.cover) ? post.cover : BASE + post.cover)
    : (BASE + '/og-image.png');
  const recent = posts.filter((p) => p.slug !== post.slug).slice(0, 4);

  const ld = [
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: BASE + '/' },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: BASE + '/blog' },
        { '@type': 'ListItem', position: 3, name: post.title, item: canonical },
      ],
    },
    {
      '@context': 'https://schema.org', '@type': 'BlogPosting',
      headline: post.title,
      description: post.description,
      datePublished: post.dateISO,
      dateModified: post.dateISO,
      author: { '@type': 'Organization', name: 'GrowthIM', url: BASE },
      publisher: {
        '@type': 'Organization', name: 'GrowthIM', url: BASE,
        logo: { '@type': 'ImageObject', url: BASE + '/og-image.png' },
      },
      image: ogImage,
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
      url: canonical,
    },
  ];

  const articleMeta = `<meta property="article:published_time" content="${post.dateISO}">\n`
    + `<meta property="article:author" content="${esc(post.author)}">`;

  const body = `
<section class="hero"><div class="hero-inner">
  <p class="crumbs"><a href="/">Home</a> &rsaquo; <a href="/blog">Blog</a> &rsaquo; ${esc(post.title)}</p>
  <h1>${esc(post.title)}</h1>
  <p class="post-meta">${esc(post.dateDisplay)} &middot; ${esc(post.author)} &middot; ${post.readingMins} min read</p>
</div></section>
<main><div class="content">
  <article>
    <p class="post-lead">${esc(post.description)}</p>
    <div class="post-body">${post.html}</div>
  </article>

  <div class="cta">
    <p class="t">See this kind of analysis for your own business</p>
    <p class="s">$29.99 one-time &middot; ~50-page report &middot; delivered to your dashboard</p>
    <a class="btn" href="/app">Analyze My Business &rarr;</a>
  </div>

  <div class="post-foot">
    ${recent.length ? `<h2 style="font-size:20px;color:var(--navy);margin:0 0 12px;">More from the blog</h2>
    <div class="related">
      ${recent.map((p) => `<a href="/blog/${p.slug}">${esc(p.title)}</a>`).join('\n      ')}
      <a href="/blog">All posts &rarr;</a>
    </div>` : `<p><a href="/blog">&larr; Back to all posts</a></p>`}
  </div>
</div></main>`;

  return blogShell({
    title: `${post.title} | GrowthIM Blog`,
    desc: post.description,
    canonical,
    ogType: 'article',
    ogImage,
    articleMeta,
    ldBlocks: ld,
    body,
  });
}

// ── Blog history list ────────────────────────────────────────────────
function renderList(posts) {
  const canonical = BASE + '/blog';
  const ld = [
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: BASE + '/' },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: canonical },
      ],
    },
    {
      '@context': 'https://schema.org', '@type': 'Blog',
      name: 'GrowthIM Blog',
      url: canonical,
      description: 'Local market intelligence, competitor analysis, and growth playbooks for small business owners.',
      blogPost: posts.slice(0, 20).map((p) => ({
        '@type': 'BlogPosting', headline: p.title, url: `${BASE}/blog/${p.slug}`,
        datePublished: p.dateISO, description: p.description,
      })),
    },
  ];

  const items = posts.length
    ? posts.map((p) => `
    <div class="blog-item">
      ${p.pinned ? '<span class="blog-badge">Start Here</span>' : ''}
      <h2><a href="/blog/${p.slug}">${esc(p.title)}</a></h2>
      <p class="meta">${esc(p.dateDisplay)} &middot; ${esc(p.author)} &middot; ${p.readingMins} min read</p>
      <p class="preview">${esc(p.excerpt)}</p>
      <a class="more" href="/blog/${p.slug}">Read more &rarr;</a>
    </div>`).join('\n')
    : `<p>No posts yet. Check back soon.</p>`;

  const body = `
<section class="hero"><div class="hero-inner">
  <p class="crumbs"><a href="/">Home</a> &rsaquo; Blog</p>
  <h1>GrowthIM Blog</h1>
  <p class="hero-meta">Local market intelligence, competitor analysis, and growth playbooks for small business owners.</p>
</div></section>
<main><div class="content">
  <div class="blog-list">${items}</div>
  <div class="cta">
    <p class="t">Get a full market analysis for your business</p>
    <p class="s">$29.99 one-time &middot; ~50-page report &middot; delivered to your dashboard</p>
    <a class="btn" href="/app">Analyze My Business &rarr;</a>
  </div>
</div></main>`;

  return blogShell({
    title: 'GrowthIM Blog | Local Market Intelligence for Small Business',
    desc: 'Local market intelligence, competitor analysis, and growth playbooks for small business owners. Practical guides from the GrowthIM team.',
    canonical,
    ogType: 'website',
    ldBlocks: ld,
    body,
  });
}

// ── Sitemap ──────────────────────────────────────────────────────────
function sitemapBlogXml(posts) {
  const lm = new Date().toISOString().split('T')[0];
  const url = (loc, lastmod, cf, pr) =>
    `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${cf}</changefreq>\n    <priority>${pr}</priority>\n  </url>`;
  const rows = [url(`${BASE}/blog`, lm, 'weekly', '0.7')]
    .concat(posts.map((p) => url(`${BASE}/blog/${p.slug}`, p.dateISO || lm, 'monthly', '0.7')));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>`;
}

// ── Route registration ───────────────────────────────────────────────
function register(app) {
  reload();
  if (!POSTS.length) {
    console.warn('[blog] no posts in content/blog — /blog will render an empty state');
  }
  // Cache keys include POSTS.length so the list/sitemap refresh if the post
  // count changes within a running process (e.g. a future reload()).
  app.get('/blog', (req, res) =>
    send(res, 'text/html; charset=utf-8', 'blog:hub:' + POSTS.length, () => renderList(POSTS)));

  app.get('/blog/:slug', (req, res, next) => {
    const post = BY_SLUG.get(String(req.params.slug || ''));
    if (!post) return next(); // unknown slug → falls through to the normal 404
    send(res, 'text/html; charset=utf-8', 'blog:post:' + post.slug, () => renderPost(post, POSTS));
  });

  app.get('/sitemap-blog.xml', (req, res) =>
    send(res, 'application/xml; charset=utf-8', 'sm:blog:' + POSTS.length, () => sitemapBlogXml(POSTS)));

  console.log(`[blog] registered: /blog + ${POSTS.length} post(s) + /sitemap-blog.xml`);
}

// reload + loadPosts are exported for Phase 2 (admin editor refreshes content
// without a restart). register() is what server.js calls.
module.exports = { register, reload, loadPosts };
