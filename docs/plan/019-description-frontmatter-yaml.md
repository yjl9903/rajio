# Description Frontmatter YAML Parsing

## Summary

Replace `gray-matter` with a small start-of-file frontmatter parser and the `yaml` package.

## Behavior

- Parse YAML only when `description.md` starts with a `---` delimiter line.
- Use the next `---` delimiter line as the end of frontmatter.
- Treat files without frontmatter as plain body.
- Treat empty, scalar, or array frontmatter as an empty object.
- Keep existing session frontmatter normalization for `media`, `title`, `url`, and `published_at`.
- Do not implement unused `gray-matter` features such as custom delimiters, excerpts, engines, or language markers.

## Tests

- Cover normal, empty, and missing frontmatter.
- Cover body text containing later `---` lines.
- Cover scalar normalization and invalid YAML errors.
