/**
 * Position mapping utilities for gen-block transformations
 *
 * Implements bidirectional position mapping between original source (with gen {})
 * and transformed source (with Effect.gen()) using VLQ-decoded source maps.
 *
 * The source map approach ensures that positions within expressions are
 * accurately mapped, fixing go-to-definition offset issues.
 */

import type * as ts from "typescript"

/**
 * Source map data structure
 */
export interface SourceMapData {
  version: number
  file?: string
  sources: Array<string>
  sourcesContent?: Array<string | null>
  names: Array<string>
  mappings: string
}

/**
 * Decoded mapping segment
 */
interface DecodedMapping {
  generatedLine: number
  generatedColumn: number
  sourceIndex: number
  originalLine: number
  originalColumn: number
  nameIndex?: number
}

// Base64 decoding table for VLQ
const BASE64_DECODE: Record<string, number> = {}
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_DECODE[BASE64_CHARS[i]] = i
}

/**
 * Decode a VLQ-encoded string into an array of integers
 */
function decodeVLQ(encoded: string): Array<number> {
  const values: Array<number> = []
  let shift = 0
  let value = 0

  for (const char of encoded) {
    const digit = BASE64_DECODE[char]
    if (digit === undefined) continue

    const hasContinuation = (digit & 0b100000) !== 0
    value += (digit & 0b11111) << shift

    if (hasContinuation) {
      shift += 5
    } else {
      // Decode sign from LSB
      const negative = (value & 1) !== 0
      value >>>= 1
      values.push(negative ? -value : value)
      value = 0
      shift = 0
    }
  }

  return values
}

/**
 * Decode source map mappings string into structured data
 */
function decodeMappings(mappings: string): Array<DecodedMapping> {
  const decoded: Array<DecodedMapping> = []
  const lines = mappings.split(";")

  let prevSourceIndex = 0
  let prevOrigLine = 0
  let prevOrigCol = 0
  let prevNameIndex = 0

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]
    if (!line) continue

    const segments = line.split(",")
    let genCol = 0

    for (const segment of segments) {
      if (!segment) continue

      const values = decodeVLQ(segment)
      if (values.length === 0) continue

      // Values are delta-encoded
      genCol += values[0]

      if (values.length >= 4) {
        prevSourceIndex += values[1]
        prevOrigLine += values[2]
        prevOrigCol += values[3]

        const mapping: DecodedMapping = {
          generatedLine: lineNum + 1, // 1-based
          generatedColumn: genCol,
          sourceIndex: prevSourceIndex,
          originalLine: prevOrigLine + 1, // Convert to 1-based
          originalColumn: prevOrigCol
        }

        if (values.length >= 5) {
          prevNameIndex += values[4]
          mapping.nameIndex = prevNameIndex
        }

        decoded.push(mapping)
      }
    }
  }

  return decoded
}

export interface TransformCacheEntry {
  /** Original source code (with gen {} syntax) */
  originalSource: string
  /** Transformed source code (with Effect.gen()) */
  transformedSource: string
  /** Source map for position mapping */
  sourceMap: SourceMapData
  /** Decoded mappings for efficient lookups */
  decodedMappings: Array<DecodedMapping>
  /** Filename for the source */
  filename: string
}

/**
 * Position mapper using source maps
 *
 * Provides accurate bidirectional position mapping using decoded source maps.
 */
export class PositionMapper {
  private readonly decodedMappings: Array<DecodedMapping>
  private readonly originalSource: string
  private readonly transformedSource: string

  constructor(
    sourceMap: SourceMapData,
    _filename: string,
    originalSource: string,
    transformedSource: string
  ) {
    this.decodedMappings = decodeMappings(sourceMap.mappings)
    this.originalSource = originalSource
    this.transformedSource = transformedSource
  }

  /**
   * Convert an absolute position to line/column (1-based line, 0-based column)
   */
  private positionToLineColumn(source: string, pos: number): { line: number; column: number } {
    const lines = source.slice(0, pos).split("\n")
    return {
      line: lines.length,
      column: lines[lines.length - 1].length
    }
  }

  /**
   * Convert line/column to absolute position
   */
  private lineColumnToPosition(source: string, line: number, column: number): number {
    const lines = source.split("\n")
    let pos = 0
    for (let i = 0; i < line - 1 && i < lines.length; i++) {
      pos += lines[i].length + 1 // +1 for newline
    }
    return pos + column
  }

  /**
   * Find the best mapping for a generated position (binary search)
   */
  private findMappingForGenerated(line: number, column: number): DecodedMapping | null {
    // Filter mappings for this generated line
    const lineMappings = this.decodedMappings.filter((m) => m.generatedLine === line)
    if (lineMappings.length === 0) {
      // Try to find any mapping on previous lines
      for (let l = line - 1; l >= 1; l--) {
        const prevLineMappings = this.decodedMappings.filter((m) => m.generatedLine === l)
        if (prevLineMappings.length > 0) {
          return prevLineMappings[prevLineMappings.length - 1]
        }
      }
      return null
    }

    // Find the mapping with the largest column <= target column
    let best: DecodedMapping | null = null
    for (const m of lineMappings) {
      if (m.generatedColumn <= column) {
        if (!best || m.generatedColumn > best.generatedColumn) {
          best = m
        }
      }
    }

    return best || lineMappings[0]
  }

  /**
   * Find the best mapping for an original position
   */
  private findMappingForOriginal(line: number, column: number): DecodedMapping | null {
    // Find mappings for this original line
    const lineMappings = this.decodedMappings.filter((m) => m.originalLine === line)
    if (lineMappings.length === 0) {
      // Try to find any mapping on previous lines
      for (let l = line - 1; l >= 1; l--) {
        const prevLineMappings = this.decodedMappings.filter((m) => m.originalLine === l)
        if (prevLineMappings.length > 0) {
          return prevLineMappings[prevLineMappings.length - 1]
        }
      }
      return null
    }

    // Find the mapping with the largest column <= target column
    let best: DecodedMapping | null = null
    for (const m of lineMappings) {
      if (m.originalColumn <= column) {
        if (!best || m.originalColumn > best.originalColumn) {
          best = m
        }
      }
    }

    return best || lineMappings[0]
  }

  /**
   * Map a position from original source to transformed source
   */
  originalToTransformed(pos: number): number {
    const { column, line } = this.positionToLineColumn(this.originalSource, pos)
    const mapping = this.findMappingForOriginal(line, column)

    if (!mapping) {
      return pos
    }

    // Calculate offset from the mapping point
    const columnOffset = column - mapping.originalColumn
    const targetColumn = mapping.generatedColumn + columnOffset

    return this.lineColumnToPosition(this.transformedSource, mapping.generatedLine, Math.max(0, targetColumn))
  }

  /**
   * Map a position from transformed source back to original source
   */
  transformedToOriginal(pos: number): number {
    const { column, line } = this.positionToLineColumn(this.transformedSource, pos)
    const mapping = this.findMappingForGenerated(line, column)

    if (!mapping) {
      return pos
    }

    // Calculate offset from the mapping point
    const columnOffset = column - mapping.generatedColumn
    const targetColumn = mapping.originalColumn + columnOffset

    return this.lineColumnToPosition(this.originalSource, mapping.originalLine, Math.max(0, targetColumn))
  }

  /**
   * Get the original source
   */
  getOriginalSource(): string {
    return this.originalSource
  }

  /**
   * Get the transformed source
   */
  getTransformedSource(): string {
    return this.transformedSource
  }
}

/**
 * Cache of transformed files for position mapping
 */
const transformCache = new Map<string, TransformCacheEntry>()

/**
 * Store a transformation result for later position mapping
 *
 * @param fileName - The file name
 * @param originalSource - Original source code
 * @param transformedSource - Transformed source code
 * @param sourceMap - Source map
 */
export function cacheTransformation(
  fileName: string,
  originalSource: string,
  transformedSource: string,
  sourceMap: SourceMapData
): PositionMapper {
  const decodedMappings = decodeMappings(sourceMap.mappings)

  transformCache.set(fileName, {
    originalSource,
    transformedSource,
    sourceMap,
    decodedMappings,
    filename: sourceMap.sources[0] || fileName
  })

  return new PositionMapper(sourceMap, sourceMap.sources[0] || fileName, originalSource, transformedSource)
}

/**
 * Get cached transformation for a file
 */
export function getCachedTransformation(fileName: string): TransformCacheEntry | undefined {
  return transformCache.get(fileName)
}

/**
 * Get position mapper for a file
 */
export function getPositionMapper(fileName: string): PositionMapper | undefined {
  const cached = transformCache.get(fileName)
  if (!cached) return undefined
  return new PositionMapper(
    cached.sourceMap,
    cached.filename,
    cached.originalSource,
    cached.transformedSource
  )
}

/**
 * Clear cached transformation for a file
 */
export function clearCachedTransformation(fileName: string): void {
  transformCache.delete(fileName)
}

/**
 * Clear all cached transformations
 */
export function clearAllCachedTransformations(): void {
  transformCache.clear()
}

/**
 * Map a position from transformed code back to original code
 */
export function mapTransformedToOriginal(
  fileName: string,
  transformedPosition: number
): number {
  const mapper = getPositionMapper(fileName)
  if (!mapper) return transformedPosition
  return mapper.transformedToOriginal(transformedPosition)
}

/**
 * Map a position from original code to transformed code
 */
export function mapOriginalToTransformed(
  fileName: string,
  originalPosition: number
): number {
  const mapper = getPositionMapper(fileName)
  if (!mapper) return originalPosition
  return mapper.originalToTransformed(originalPosition)
}

/**
 * Map a text span from transformed code back to original code
 */
export function mapTextSpan(
  fileName: string,
  span: ts.TextSpan
): ts.TextSpan {
  const mapper = getPositionMapper(fileName)
  if (!mapper) return span

  const originalStart = mapper.transformedToOriginal(span.start)
  const originalEnd = mapper.transformedToOriginal(span.start + span.length)

  return {
    start: originalStart,
    length: Math.max(0, originalEnd - originalStart)
  }
}

/**
 * Map a text span from original code to transformed code
 */
export function mapTextSpanToTransformed(
  fileName: string,
  span: ts.TextSpan
): ts.TextSpan {
  const mapper = getPositionMapper(fileName)
  if (!mapper) return span

  const transformedStart = mapper.originalToTransformed(span.start)
  const transformedEnd = mapper.originalToTransformed(span.start + span.length)

  return {
    start: transformedStart,
    length: Math.max(0, transformedEnd - transformedStart)
  }
}

/**
 * Map diagnostic positions from transformed code back to original code
 */
export function mapDiagnosticPositions<D extends ts.Diagnostic>(
  diagnostics: ReadonlyArray<D>
): Array<D> {
  return diagnostics.map((diagnostic) => {
    if (!diagnostic.file || diagnostic.start === undefined) {
      return diagnostic
    }

    const fileName = diagnostic.file.fileName
    const mapper = getPositionMapper(fileName)
    if (!mapper) {
      return diagnostic
    }

    const originalStart = mapper.transformedToOriginal(diagnostic.start)
    const originalLength = diagnostic.length !== undefined
      ? mapper.transformedToOriginal(diagnostic.start + diagnostic.length) - originalStart
      : diagnostic.length

    return {
      ...diagnostic,
      start: originalStart,
      length: originalLength
    }
  })
}

/**
 * Check if a file has been transformed
 */
export function isTransformedFile(fileName: string): boolean {
  return transformCache.has(fileName)
}

/**
 * Get the original source for a transformed file
 */
export function getOriginalSource(fileName: string): string | undefined {
  return transformCache.get(fileName)?.originalSource
}

/**
 * Get the transformed source for a file
 */
export function getTransformedSource(fileName: string): string | undefined {
  return transformCache.get(fileName)?.transformedSource
}
