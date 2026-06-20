# How to publish a blog post (Phase 1)

The blog at **growthim.com/blog** is file based. Each post is one markdown file
in this folder (`content/blog/`). To publish a post you write a file, push it to
GitHub, and Railway redeploys automatically. There is no admin login yet (that
is Phase 2).

## 1. Create the post file

Copy `TEMPLATE.md` to a new file in this folder. The file name becomes the URL
unless you set a `slug`, so name it with lowercase words and dashes:

```
content/blog/how-to-price-a-haircut.md   ->   growthim.com/blog/how-to-price-a-haircut
```

## 2. Fill in the front matter

The block at the very top between the `---` lines is the post's metadata:

| Field         | Required | What it does |
|---------------|----------|--------------|
| `title`       | Yes      | The post headline. Shows as the H1, the browser tab title, and the SEO title. |
| `slug`        | No       | The URL after `/blog/`. Defaults to the file name. Once published, do not change it (it breaks links and SEO). |
| `date`        | Yes      | Publish date, written as `YYYY-MM-DD`. Controls ordering (newest first) and the displayed date. |
| `author`      | No       | Defaults to `GrowthIM Team`. |
| `description` | Yes      | One or two sentences (about 150 characters). Used as the SEO meta description, the social preview text, the list preview, and the bold lead under the title. Make it answer the post's main question. |
| `cover`       | No       | Path to a social and list image, like `/blog-images/my-image.png`. Used for Open Graph, Twitter, and the article schema. |

## 3. Write the body

Below the second `---`, write in markdown:

- `## Heading` and `### Sub heading` for sections (the title is already the H1, so start body sections at `##`)
- `**bold text**` for emphasis
- Normal paragraphs, just type them with a blank line between
- `- item` for bullet lists, `1. item` for numbered lists
- `> quote` for a callout
- `[link text](/app)` to link to your own pages (good for SEO and navigation)

**Answer first:** put the main point in the first 100 to 150 words. This helps
both Google and AI search engines surface your answer.

## 4. Add images

1. Put image files in `public/blog-images/` (for example `public/blog-images/pricing-chart.png`).
2. Reference them in the post with a leading `/blog-images/` path and you can
   place one anywhere in the body:

```
![A short description of the image](/blog-images/pricing-chart.png)
```

The description in the brackets is the alt text. Always write a real one, it
helps accessibility and SEO. Images are automatically made responsive and lazy
loaded.

## 5. Preview locally (optional)

```
npm start
```

Then open `http://localhost:3000/blog` and your post URL to check it before
publishing.

## 6. Publish

Stage only your new post and images, commit, and push:

```
git add content/blog/your-post.md public/blog-images/your-image.png
git commit -m "blog: your post title"
git push origin main
```

Railway redeploys automatically and the post is live at
`growthim.com/blog/your-post`. It is also added to the sitemap
(`/sitemap-blog.xml`) so Google can find it.

> Do not run `git add .` or `git add -A`. Stage only the blog files you mean to
> publish so local-only files (like `coverage_list.csv`) are never committed.

## Notes

- `TEMPLATE.md` and this `README.md` are ignored by the blog, so they never
  appear as posts. Files starting with `_` or `.` are ignored too.
- To unpublish a post, delete its `.md` file and push. To rename, prefer adding
  a new post over changing an existing `slug`.
