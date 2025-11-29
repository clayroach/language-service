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
 * Implements VLQ encoding directly without external dependencies.
 */

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

// Base64 encoding characters for VLQ
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/**
 * Encode a single integer as VLQ Base64
 */
function encodeVLQ(value: number): string {
  let result = ""
  // Convert to sign-magnitude representation
  let signBit = 0
  if (value < 0) {
    signBit = 1
    value = -value
  }

  // First 4 bits + sign bit
  let digit = (value & 0b1111) << 1 | signBit
  value >>>= 4

  // If there are more bits, set continuation bit
  while (value > 0) {
    result += BASE64_CHARS[digit | 0b100000]
    digit = value & 0b11111
    value >>>= 5
  }

  result += BASE64_CHARS[digit]
  return result
}

/**
 * Lightweight text editor with source map support
 *
 * Tracks edits and generates source maps with built-in VLQ encoding.
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

    // Encode mappings to VLQ format
    const encodedMappings = this.encodeMappings(mappings)

    const result: SourceMapData = {
      version: 3,
      sources: [sourceName],
      names: [],
      mappings: encodedMappings
    }

    if (options.file) {
      result.file = options.file
    }

    if (options.includeContent) {
      result.sourcesContent = [this.original]
    }

    return result
  }

  /**
   * Encode mappings array to VLQ string format
   */
  private encodeMappings(mappings: Array<Mapping>): string {
    // Sort mappings by generated position
    const sorted = [...mappings].sort((a, b) => {
      if (a.generatedLine !== b.generatedLine) {
        return a.generatedLine - b.generatedLine
      }
      return a.generatedColumn - b.generatedColumn
    })

    // Remove duplicates (same generated line/column)
    const unique: Array<Mapping> = []
    for (const m of sorted) {
      const last = unique[unique.length - 1]
      if (!last || last.generatedLine !== m.generatedLine || last.generatedColumn !== m.generatedColumn) {
        unique.push(m)
      }
    }

    // Group by generated line
    const lines: Array<Array<Mapping>> = []
    for (const m of unique) {
      while (lines.length < m.generatedLine) {
        lines.push([])
      }
      lines[m.generatedLine - 1].push(m)
    }

    // Encode each line
    // All values are relative to previous values
    let prevGenCol = 0
    let prevOrigLine = 0
    let prevOrigCol = 0
    const sourceIndex = 0 // We only have one source

    const encodedLines: Array<string> = []

    for (const line of lines) {
      const segments: Array<string> = []
      prevGenCol = 0 // Reset column at start of each line

      for (const m of line) {
        // Each segment: [genCol, sourceIdx, origLine, origCol]
        // All values are relative/delta encoded
        const genColDelta = m.generatedColumn - prevGenCol
        const origLineDelta = (m.originalLine - 1) - prevOrigLine // Convert to 0-based
        const origColDelta = m.originalColumn - prevOrigCol

        segments.push(
          encodeVLQ(genColDelta) +
            encodeVLQ(sourceIndex) + // Always 0 (relative, so always 0 delta)
            encodeVLQ(origLineDelta) +
            encodeVLQ(origColDelta)
        )

        prevGenCol = m.generatedColumn
        prevOrigLine = m.originalLine - 1
        prevOrigCol = m.originalColumn
      }

      encodedLines.push(segments.join(","))
    }

    return encodedLines.join(";")
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

    for (const edit of sortedEdits) {
      switch (edit.type) {
        case "overwrite": {
          const end = edit.end!
          result = result.slice(0, edit.pos) + edit.content + result.slice(end)
          break
        }
        case "insertLeft":
        case "insertRight": {
          result = result.slice(0, edit.pos) + edit.content + result.slice(edit.pos)
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
