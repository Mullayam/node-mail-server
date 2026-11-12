# docs

The documentation site for NodeMailServer, built with
[Next.js](https://nextjs.org) and [Fumadocs](https://fumadocs.vercel.app).

## Run it

```bash
cd docs
bun install
bun run dev
```

Open http://localhost:3000. Build for production with `bun run build`.

## Where things are

| Path | Contents |
|------|----------|
| `content/docs/` | The pages, as `.mdx` files. |
| `content/docs/**/meta.json` | The title and page order of each sidebar section. |
| `public/images/` | Screenshots used in the pages, referenced as `/images/<name>.png`. |
| `app/` | The Next.js layouts and the landing page. |

## Add a page

1. Create `content/docs/<section>/<name>.mdx` with a front matter block:

   ```mdx
   ---
   title: Page title
   description: One sentence that shows under the title.
   ---
   ```

2. Add `<name>` to the `pages` list in that section's `meta.json`.

Pages can use the built-in `Callout` (`type` is `info`, `warn` or `error`) and
`Cards` and `Card` components, plus normal Markdown.
