Below is a clean, copy-ready README designed specifically for GitHub.
No installation steps, no references to this chat, fully self-contained, and formatted for ideal GitHub rendering.

---

# Geometry Dash Level Search Discord Bot

A single-file Discord bot that can search Geometry Dash levels with advanced filters and return clean, paginated results in professional embeds.

## Features

* Search Geometry Dash levels by:

  * Text query (name, creator, tags)
  * Length category: `short`, `normal`, `long`, `xl`
  * Exact length in seconds (when metadata allows)
  * Minimum, maximum, or exact object count
  * Required object IDs (comma-separated)
  * Difficulty: `auto`, `easy`, `normal`, `hard`, `harder`, `insane`, `demon`
  * Search limit (controls how many levels are checked)
* Decodes level data to inspect:

  * Object list
  * Object count
  * Timing metadata (if available)
* Professional Discord embeds with:

  * Level name
  * Level ID
  * Creator
  * Object count
  * Length in seconds (best effort)
  * Preview link
* Paginated results using buttons
* Automatic skipping of levels that cannot be decoded
* Fully contained in one JavaScript file

## Usage

Use the main slash command:

```
/findlevel
```

Then provide whichever filters you want. Examples:

```
/findlevel query:"challenge" lengthcategory:xl
```

```
/findlevel minobjects:1000 requiredobjectids:"1,2,57"
```

```
/findlevel exactlength:62 difficulty:demon
```

## Behavior

* The bot requests levels from the servers, decodes each level, checks your filters, and sends the matching results.
* If multiple levels match, results are shown as a paginated embed with Next/Previous buttons.
* Levels missing timing metadata cannot be matched against exact-second length filters.
* Levels failing to decode cleanly are automatically skipped.

## Feedback

Feedback, suggestions, and feature requests are welcome.
If you enjoy the project, consider giving it a star on GitHub.
