---
name: knowledge-base
description: Accumulate and retrieve shared knowledge across all conversations. Write valuable information learned from any group into the knowledge base. Search it before answering domain-specific questions. Uses Obsidian-flavored Markdown with frontmatter, wikilinks, and tags.
allowed-tools: Bash(qmd:*), Read, Write, Edit, Glob
---

# Knowledge Base

Shared knowledge lives at `/workspace/global/knowledge/`. All agents read and write to it. Use this to accumulate institutional knowledge, background context, and reference material across conversations.

## When to write

- User shares domain knowledge, processes, or conventions worth remembering
- You research something that would be useful in future conversations
- You learn project context, team preferences, or technical decisions
- User corrects you on something — record the correct information

Don't write trivial or session-specific things (that's what group-level memory is for).

## How to write

Use Obsidian-flavored Markdown with frontmatter:

```markdown
---
tags: [domain/area, topic]
source: group conversation / user / research
updated: 2026-03-09
---

# Title

Content here. Link to related notes with [[other-note]].
```

Conventions:
- **File names**: lowercase, hyphens, descriptive (e.g. `deployment-process.md`, `api-rate-limits.md`)
- **Tags**: hierarchical with `/` (e.g. `ops/deploy`, `product/pricing`, `team/backend`)
- **Wikilinks**: `[[related-note]]` to connect related knowledge
- **One topic per file**, split if a file exceeds ~200 lines
- **Update over duplicate**: if a note on the topic exists, update it instead of creating a new one

```bash
# Check if a note already exists before creating
ls /workspace/global/knowledge/
qmd search "topic" --collection kb

# Write a new note
cat > /workspace/global/knowledge/topic-name.md << 'EOF'
---
tags: [domain/area]
updated: 2026-03-09
---

# Topic Name

Content...
EOF
```

## When to search

- Before answering domain-specific questions
- When user references concepts, projects, or terms that might be documented
- When you need background context

## How to search

```bash
# Index (first time or after writing new notes)
qmd collection add /workspace/global/knowledge --name kb --mask "*.md"
qmd embed

# Search
qmd query "deployment process" --collection kb
qmd search "API credentials" --collection kb -n 10
```

When you find a `[[wikilink]]` in a note, follow it:

```bash
qmd search "linked-note-name" --collection kb
```

## Important

- Cite the source when using knowledge base info (e.g. "根据 deployment-guide.md")
- Don't dump entire documents into responses — extract the relevant parts
- After writing new notes, re-index: `qmd collection add /workspace/global/knowledge --name kb --mask "*.md"`
