---
name: qmd
description: Search local documents using BM25 + vector search + LLM reranking. Use for searching through large codebases, documentation, or any text files when you need to find relevant content without reading everything. Much faster and cheaper than scanning files manually.
allowed-tools: Bash(qmd:*)
---

# QMD — Local Document Search

## Quick start

```bash
qmd collection add . --name project   # Index current directory
qmd query "authentication flow"       # Search with query expansion + reranking (recommended)
qmd search "error handling" -n 5      # BM25 keyword search (faster, no LLM)
```

## When to use QMD vs other tools

| Scenario | Use |
|----------|-----|
| Know exact file path | `Read` tool |
| Know exact string/regex | `Grep` tool |
| Semantic/conceptual search across many files | `qmd query` |
| Fast keyword search (no LLM cost) | `qmd search` |
| Explore unfamiliar codebase | `qmd collection add . && qmd query` |
| Large documentation corpus | `qmd collection add && qmd query` |

**Rule of thumb:** If you'd need more than 3 grep attempts to find what you need, use QMD instead.

## Commands

### Indexing (collections)

```bash
qmd collection add .              --name project  # Index current directory
qmd collection add ./docs         --name docs     # Index specific directory
qmd collection add . --mask "*.md" --name docs    # Only index files matching pattern
qmd collection list                                # List all collections
qmd collection remove <name>                       # Remove a collection
qmd update                                         # Re-index all collections
qmd update --pull                                  # Git pull then re-index
qmd embed                                          # Create vector embeddings (needed for vsearch/query)
```

### Searching

```bash
qmd query "query"              # Query expansion + reranking (recommended, uses LLM)
qmd search "query"             # BM25 full-text keyword search (no LLM, fast)
qmd vsearch "query"            # Vector similarity search (no reranking)
qmd query "query" -n 10        # Return top N results (default: 5)
```

### Reading results

```bash
qmd get <file>                 # Get full document
qmd get <file>:50 -l 20       # Get 20 lines starting at line 50
qmd multi-get "*.ts" -l 50    # Get multiple docs by glob pattern
```

### Info

```bash
qmd status                     # Show index status and collections
qmd ls                         # List collections
qmd ls <collection>            # List files in a collection
qmd --help                     # Full command reference
```

## Typical workflow

```bash
# 1. Index the project (one-time, ~30s for medium project)
qmd collection add . --name project
qmd embed  # Create vector embeddings for semantic search

# 2. Search as needed
qmd query "how does user authentication work"
qmd query "database migration pattern"
qmd search "error handling" -n 10  # Fast keyword search

# 3. Read the files QMD points you to
qmd get src/auth.ts:25 -l 50  # Or use the Read tool
```

## First-time usage note

The first `qmd embed` or `qmd vsearch`/`qmd query` triggers a one-time download of the embedding model (~300MB). This takes 30-60 seconds. Subsequent uses are fast. The model is cached in `~/.cache/qmd/models/`.
