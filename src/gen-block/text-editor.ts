/**
 * Minimal text editor with source map generation
 *
 * A lightweight replacement for MagicString that provides only the
 * operations needed for gen-block transformations:
 * - overwrite(start, end, content): replace a range
 * - appendLeft(pos, content): insert before position
 * - appendRight(pos, content): insert after position
 * - toString(): get the transformed string
 * - generateMap(): generate a source map
 *
 * Uses @jridgewell/gen-mapping for source map generation.
 */

import { addMapping, GenMapping, toEncodedMap } from "@jridgewell/gen-mapping"
import type { SourceMapData } from "./position-mapper"

/**
 * Represents an edit operation on the source text
 */
interface Edit {
  /** Type of edit */
  type: "overwrite" | "insertLeft" | "insertRight"
  /** Position in original source */
  pos: number
  /** End position for overwrite (exclusive) */
  end?: number
  /** Content to insert or replace with */
  content: string
}

/**
 * Options for source map generation
 */
export interface GenerateMapOptions {
  /** Source filename */
  source?: string
  /** Output map filename */
  file?: string
  /** Include source content in the map */
  includeContent?: boolean
  /** High-resolution mappings (character-level) */
  hires?: boolean
}

/**
 * Lightweight text editor with source map support
 *
 * Tracks edits and generates source maps using @jridgewell/gen-mapping.
 */
export class TextEditor {
  private readonly original: string
  private readonly edits: Array<Edit> = []

  constructor(source: string) {
    this.original = source
  }

  /**
   * Replace a range of text
   */
  overwrite(start: number, end: number, content: string): this {
    this.edits.push({ type: "overwrite", pos: start, end, content })
    return this
  }

  /**
   * Insert content before a position
   */
  appendLeft(pos: number, content: string): this {
    this.edits.push({ type: "insertLeft", pos, content })
    return this
  }

  /**
   * Insert content after a position
   */
  appendRight(pos: number, content: string): this {
    this.edits.push({ type: "insertRight", pos, content })
    return this
  }

  /**
   * Apply all edits and return the transformed string
   */
  toString(): string {
    return this.applyEdits().result
  }

  /**
   * Generate a source map for the transformation
   */
  generateMap(options: GenerateMapOptions = {}): SourceMapData {
    const { mappings } = this.applyEdits()
    const sourceName = options.source || "source.ts"

    const map = new GenMapping({
      file: options.file ?? null,
      sourceRoot: ""
    })

    // Add mappings from original to generated positions
    for (const mapping of mappings) {
      addMapping(map, {
        source: sourceName,
        original: { line: mapping.originalLine, column: mapping.originalColumn },
        generated: { line: mapping.generatedLine, column: mapping.generatedColumn }
      })
    }

    const encoded = toEncodedMap(map)

    const result: SourceMapData = {
      version: encoded.version,
      sources: [sourceName],
      names: [...encoded.names],
      mappings: encoded.mappings
    }

    if (encoded.file) {
      result.file = encoded.file
    }

    if (options.includeContent) {
      result.sourcesContent = [this.original]
    }

    return result
  }

  /**
   * Apply edits and compute mappings
   */
  private applyEdits(): { result: string; mappings: Array<Mapping> } {
    // Sort edits by position (descending) so we process from end to start
    // This prevents position shifts from affecting subsequent edits
    const sortedEdits = [...this.edits].sort((a, b) => {
      // Primary sort by position (descending)
      if (b.pos !== a.pos) return b.pos - a.pos
      // Secondary sort: insertRight before insertLeft at same position
      if (a.type === "insertRight" && b.type === "insertLeft") return -1
      if (a.type === "insertLeft" && b.type === "insertRight") return 1
      return 0
    })

    // Build the result string and track position mappings
    let result = this.original
    const positionAdjustments: Array<{ pos: number; delta: number }> = []

    for (const edit of sortedEdits) {
      switch (edit.type) {
        case "overwrite": {
          const end = edit.end!
          const oldLen = end - edit.pos
          const newLen = edit.content.length
          result = result.slice(0, edit.pos) + edit.content + result.slice(end)
          positionAdjustments.push({ pos: edit.pos, delta: newLen - oldLen })
          break
        }
        case "insertLeft":
        case "insertRight": {
          result = result.slice(0, edit.pos) + edit.content + result.slice(edit.pos)
          positionAdjustments.push({ pos: edit.pos, delta: edit.content.length })
          break
        }
      }
    }

    // Generate mappings for each character/line
    const mappings = this.generateMappings(result, sortedEdits)

    return { result, mappings }
  }

  /**
   * Generate line/column mappings between original and transformed source
   */
  private generateMappings(result: string, edits: Array<Edit>): Array<Mapping> {
    const mappings: Array<Mapping> = []

    // Build a list of edit ranges in original positions
    const editRanges: Array<{ start: number; end: number; replacement: string; insertType?: string }> = []
    for (const edit of edits) {
      if (edit.type === "overwrite") {
        editRanges.push({ start: edit.pos, end: edit.end!, replacement: edit.content })
      } else {
        // Insert operations: zero-width range at position
        editRanges.push({ start: edit.pos, end: edit.pos, replacement: edit.content, insertType: edit.type })
      }
    }

    // Sort by start position ascending
    editRanges.sort((a, b) => a.start - b.start)

    // Walk through original source and build mappings
    let originalPos = 0
    const originalLines = this.original.split("\n")

    // Simple approach: map each line start
    for (let i = 0; i < originalLines.length; i++) {
      const origLine = originalLines[i]

      // Find the corresponding generated position for this original line start
      const genPos = this.mapOriginalToGenerated(originalPos, editRanges)
      const { column: genCol, line: genLn } = this.posToLineCol(result, genPos)

      mappings.push({
        originalLine: i + 1,
        originalColumn: 0,
        generatedLine: genLn,
        generatedColumn: genCol
      })

      // Also map significant positions within the line (every few characters for hires)
      for (let col = 0; col < origLine.length; col++) {
        const charOrigPos = originalPos + col
        const charGenPos = this.mapOriginalToGenerated(charOrigPos, editRanges)
        const { column: charGenCol, line: charGenLn } = this.posToLineCol(result, charGenPos)

        mappings.push({
          originalLine: i + 1,
          originalColumn: col,
          generatedLine: charGenLn,
          generatedColumn: charGenCol
        })
      }

      originalPos += origLine.length + 1 // +1 for newline
    }

    return mappings
  }

  /**
   * Map an original position to a generated position
   */
  private mapOriginalToGenerated(
    origPos: number,
    editRanges: Array<{ start: number; end: number; replacement: string; insertType?: string }>
  ): number {
    let adjustment = 0

    for (const range of editRanges) {
      if (range.start > origPos) {
        // Edit is after our position, no effect
        break
      }

      if (range.end <= origPos) {
        // Edit is entirely before our position
        // Adjust by the difference in length
        const originalLen = range.end - range.start
        const newLen = range.replacement.length
        adjustment += newLen - originalLen
      } else if (range.start <= origPos && range.end > origPos) {
        // Position is inside an edited range
        // Map to the start of the replacement
        return range.start + adjustment
      }
    }

    return origPos + adjustment
  }

  /**
   * Convert absolute position to line/column (1-based line, 0-based column)
   */
  private posToLineCol(source: string, pos: number): { line: number; column: number } {
    const before = source.slice(0, pos)
    const lines = before.split("\n")
    return {
      line: lines.length,
      column: lines[lines.length - 1].length
    }
  }
}

/**
 * Mapping from original to generated position
 */
interface Mapping {
  originalLine: number
  originalColumn: number
  generatedLine: number
  generatedColumn: number
}
