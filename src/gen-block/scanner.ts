/**
 * Token-based scanner for gen {} blocks
 *
 * Implements a simple tokenizer that properly handles:
 * - String literals (single, double, template literals)
 * - Comments (single-line, multi-line)
 * - Identifiers and keywords
 * - Punctuators
 */

export interface GenBlock {
  /** Start position of 'gen' keyword */
  start: number
  /** End position (after closing brace) */
  end: number
  /** Content between braces (excluding braces) */
  content: string
  /** Position of opening brace */
  braceStart: number
}

/**
 * Token types we care about
 */
type TokenType =
  | "IdentifierName"
  | "Punctuator"
  | "StringLiteral"
  | "TemplateLiteral"
  | "SingleLineComment"
  | "MultiLineComment"
  | "WhiteSpace"
  | "LineTerminatorSequence"
  | "Other"

interface Token {
  type: TokenType
  value: string
  start: number
  end: number
}

/**
 * Simple tokenizer for JavaScript/TypeScript
 * Handles the cases we need for gen block parsing
 */
function tokenize(source: string): Array<Token> {
  const tokens: Array<Token> = []
  let pos = 0

  while (pos < source.length) {
    const char = source[pos]
    const start = pos

    // Whitespace
    if (char === " " || char === "\t") {
      while (pos < source.length && (source[pos] === " " || source[pos] === "\t")) {
        pos++
      }
      tokens.push({ type: "WhiteSpace", value: source.slice(start, pos), start, end: pos })
      continue
    }

    // Line terminators
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[pos + 1] === "\n") {
        pos += 2
      } else {
        pos++
      }
      tokens.push({ type: "LineTerminatorSequence", value: source.slice(start, pos), start, end: pos })
      continue
    }

    // Comments
    if (char === "/") {
      if (source[pos + 1] === "/") {
        // Single-line comment
        pos += 2
        while (pos < source.length && source[pos] !== "\n" && source[pos] !== "\r") {
          pos++
        }
        tokens.push({ type: "SingleLineComment", value: source.slice(start, pos), start, end: pos })
        continue
      }
      if (source[pos + 1] === "*") {
        // Multi-line comment
        pos += 2
        while (pos < source.length - 1 && !(source[pos] === "*" && source[pos + 1] === "/")) {
          pos++
        }
        pos += 2 // Skip */
        tokens.push({ type: "MultiLineComment", value: source.slice(start, pos), start, end: pos })
        continue
      }
    }

    // String literals
    if (char === "\"" || char === "'") {
      const quote = char
      pos++
      while (pos < source.length && source[pos] !== quote) {
        if (source[pos] === "\\") {
          pos += 2 // Skip escape sequence
        } else {
          pos++
        }
      }
      pos++ // Skip closing quote
      tokens.push({ type: "StringLiteral", value: source.slice(start, pos), start, end: pos })
      continue
    }

    // Template literals
    if (char === "`") {
      pos++
      while (pos < source.length && source[pos] !== "`") {
        if (source[pos] === "\\") {
          pos += 2 // Skip escape sequence
        } else if (source[pos] === "$" && source[pos + 1] === "{") {
          // Template expression - skip to matching }
          pos += 2
          let depth = 1
          while (pos < source.length && depth > 0) {
            if (source[pos] === "{") depth++
            else if (source[pos] === "}") depth--
            else if (source[pos] === "`") {
              // Nested template literal - recursively handle
              pos++
              while (pos < source.length && source[pos] !== "`") {
                if (source[pos] === "\\") pos += 2
                else pos++
              }
            } else if (source[pos] === "\"" || source[pos] === "'") {
              // String in template expression
              const q = source[pos]
              pos++
              while (pos < source.length && source[pos] !== q) {
                if (source[pos] === "\\") pos += 2
                else pos++
              }
            }
            pos++
          }
        } else {
          pos++
        }
      }
      pos++ // Skip closing backtick
      tokens.push({ type: "TemplateLiteral", value: source.slice(start, pos), start, end: pos })
      continue
    }

    // Identifiers (including keywords)
    if (isIdentifierStart(char)) {
      while (pos < source.length && isIdentifierPart(source[pos])) {
        pos++
      }
      tokens.push({ type: "IdentifierName", value: source.slice(start, pos), start, end: pos })
      continue
    }

    // Punctuators and operators
    if (isPunctuator(char)) {
      // Handle multi-character operators
      const twoChar = source.slice(pos, pos + 2)
      const threeChar = source.slice(pos, pos + 3)

      if (
        threeChar === "===" || threeChar === "!==" || threeChar === ">>>" ||
        threeChar === "..." || threeChar === "**="
      ) {
        pos += 3
      } else if (
        twoChar === "==" || twoChar === "!=" || twoChar === "<=" || twoChar === ">=" ||
        twoChar === "&&" || twoChar === "||" || twoChar === "++" || twoChar === "--" ||
        twoChar === "+=" || twoChar === "-=" || twoChar === "*=" || twoChar === "/=" ||
        twoChar === "=>" || twoChar === "<<" || twoChar === ">>" || twoChar === "??" ||
        twoChar === "?." || twoChar === "<-"
      ) {
        pos += 2
      } else {
        pos++
      }
      tokens.push({ type: "Punctuator", value: source.slice(start, pos), start, end: pos })
      continue
    }

    // Numbers
    if (isDigit(char) || (char === "." && isDigit(source[pos + 1]))) {
      while (
        pos < source.length &&
        (isDigit(source[pos]) || source[pos] === "." || source[pos] === "e" || source[pos] === "E" ||
          source[pos] === "_")
      ) {
        if ((source[pos] === "e" || source[pos] === "E") && (source[pos + 1] === "+" || source[pos + 1] === "-")) {
          pos += 2
        } else {
          pos++
        }
      }
      // Handle BigInt suffix
      if (source[pos] === "n") pos++
      tokens.push({ type: "Other", value: source.slice(start, pos), start, end: pos })
      continue
    }

    // Anything else
    pos++
    tokens.push({ type: "Other", value: source.slice(start, pos), start, end: pos })
  }

  return tokens
}

function isIdentifierStart(char: string): boolean {
  return /[a-zA-Z_$]/.test(char)
}

function isIdentifierPart(char: string): boolean {
  return /[a-zA-Z0-9_$]/.test(char)
}

function isDigit(char: string): boolean {
  return /[0-9]/.test(char)
}

function isPunctuator(char: string): boolean {
  return /[{}()[\];:,.<>?!+\-*/%=&|^~@#]/.test(char)
}

/**
 * Quick check if source contains gen blocks (fast path)
 */
export function hasGenBlocks(source: string): boolean {
  return /\bgen\s*\{/.test(source)
}

/**
 * Find all gen {} blocks in source using token-based parsing
 */
export function findGenBlocks(source: string): Array<GenBlock> {
  if (!hasGenBlocks(source)) {
    return []
  }

  const tokens = tokenize(source)
  const blocks: Array<GenBlock> = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]

    // Look for 'gen' identifier
    if (token.type !== "IdentifierName" || token.value !== "gen") {
      continue
    }

    // Find the next non-whitespace/comment token
    let j = i + 1
    while (j < tokens.length) {
      const nextToken = tokens[j]
      if (
        nextToken.type !== "WhiteSpace" &&
        nextToken.type !== "LineTerminatorSequence" &&
        nextToken.type !== "SingleLineComment" &&
        nextToken.type !== "MultiLineComment"
      ) {
        break
      }
      j++
    }

    // Check if it's followed by '{'
    if (j >= tokens.length) continue
    const braceToken = tokens[j]
    if (braceToken.type !== "Punctuator" || braceToken.value !== "{") {
      continue
    }

    // Found 'gen {', now find the matching '}'
    const genStart = token.start
    const braceStart = braceToken.start
    let depth = 1
    let k = j + 1

    while (k < tokens.length && depth > 0) {
      const t = tokens[k]
      if (t.type === "Punctuator") {
        if (t.value === "{") depth++
        if (t.value === "}") depth--
      }
      k++
    }

    if (depth === 0) {
      const endToken = tokens[k - 1]
      const end = endToken.end
      const content = source.slice(braceStart + 1, end - 1)

      blocks.push({
        start: genStart,
        end,
        content,
        braceStart
      })
    }
  }

  return blocks
}

/**
 * Check if a position is inside a nested function/callback
 * We want to transform binds inside control flow (if/else/try/catch)
 * but NOT inside nested functions/callbacks (different scope)
 */
function isInsideNestedFunction(tokens: Array<Token>, upToIndex: number): boolean {
  // Look for function or arrow function patterns before the current position
  // Track depth to find if we're inside a function body
  let functionDepth = 0

  for (let i = 0; i < upToIndex; i++) {
    const t = tokens[i]

    // Check for function keyword or arrow
    if (t.type === "IdentifierName" && t.value === "function") {
      // Found 'function', next '{' starts a function body
      for (let j = i + 1; j < upToIndex; j++) {
        if (tokens[j].type === "Punctuator" && tokens[j].value === "{") {
          functionDepth++
          break
        }
      }
    }

    // Check for arrow function: ) => {
    if (t.type === "Punctuator" && t.value === "=>") {
      // Look ahead for {
      for (let j = i + 1; j < upToIndex; j++) {
        const next = tokens[j]
        if (next.type === "Punctuator" && next.value === "{") {
          functionDepth++
          break
        }
        // If we hit something other than whitespace before {, it's expression arrow
        if (next.type !== "WhiteSpace" && next.type !== "LineTerminatorSequence") {
          break
        }
      }
    }

    // Track closing braces
    if (t.type === "Punctuator" && t.value === "}" && functionDepth > 0) {
      functionDepth--
    }
  }

  return functionDepth > 0
}

/**
 * Transform gen block content to Effect.gen body
 *
 * Transforms:
 * - `x <- expr` -> `const x = yield* expr` (anywhere except inside nested functions)
 *
 * Does NOT transform:
 * - let/const declarations (preserves them as-is)
 * - Binds inside nested functions/callbacks (they're a different scope)
 */
export function transformBlockContent(content: string): string {
  const tokens = tokenize(content)
  const lines = content.split("\n")
  const outputLines: Array<string> = []

  let lineStart = 0

  for (const line of lines) {
    const lineEnd = lineStart + line.length
    const trimmed = line.trim()

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("//")) {
      outputLines.push(line)
      lineStart = lineEnd + 1 // +1 for newline
      continue
    }

    // Check if this line is inside a nested function/callback
    const firstTokenIndex = tokens.findIndex((t) => t.start >= lineStart && t.start < lineEnd)
    const insideNestedFunction = firstTokenIndex >= 0 ? isInsideNestedFunction(tokens, firstTokenIndex) : false

    // Transform bind statements unless inside a nested function
    if (!insideNestedFunction) {
      // Look for pattern: identifier <- expression
      // Supports: simple vars (x), array destructuring ([a, b]), object destructuring ({ a, b })
      const bindMatch = trimmed.match(/^(\w+|\[[\w\s,]+\]|\{[\w\s,:]+\})\s*<-\s*(.+)$/)

      if (bindMatch) {
        const [, varName, exprWithSemi] = bindMatch
        const indent = line.match(/^\s*/)?.[0] || ""
        const hasSemicolon = exprWithSemi.trimEnd().endsWith(";")
        const expression = exprWithSemi.replace(/;?\s*$/, "")

        outputLines.push(
          `${indent}const ${varName} = yield* ${expression}${hasSemicolon ? ";" : ""}`
        )
        lineStart = lineEnd + 1
        continue
      }
    }

    // Pass through unchanged
    outputLines.push(line)
    lineStart = lineEnd + 1
  }

  return outputLines.join("\n")
}
