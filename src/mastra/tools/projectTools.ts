import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import archiver from 'archiver'

// Strips markdown code fences from agent output, e.g.:
// ```typescript\n...\n```  →  ...
function stripCodeFences(content: string): string {
  return content
    .replace(/^```[a-zA-Z]*\r?\n?/, '')
    .replace(/\r?\n?```\s*$/, '')
}

// Returns true if a file path looks like it belongs to the given layer.
// Prevents backend output accidentally being written into the frontend dir and vice versa.
function belongsToLayer(filePath: string, layer: 'backend' | 'frontend' | 'all'): boolean {
  if (layer === 'all') return true

  const normalized = filePath.toLowerCase().replace(/\\/g, '/')

  // Paths the LLM sometimes prefixes even when told not to — strip them before checking
  const stripped = normalized
    .replace(/^backend\//, '')
    .replace(/^frontend\//, '')
    .replace(/^src\/frontend\//, '')
    .replace(/^src\/backend\//, '')

  if (layer === 'backend') {
    // Reject anything that looks like a React/Next.js frontend file
    const frontendSignals = [
      'pages/', 'components/', 'hooks/', 'tailwind', 'next.config',
      'vite.config', 'postcss', 'app/layout', 'app/page',
      '.jsx', '.tsx', // TSX is a strong frontend signal in this context
    ]
    // Allow .tsx only if it's a NestJS DTO/spec — but safest is to block .tsx entirely for backend
    return !frontendSignals.some(sig => normalized.includes(sig))
  }

  if (layer === 'frontend') {
    // Reject anything that looks like a NestJS backend file
    const backendSignals = [
      '.module.ts', '.controller.ts', '.service.ts', '.dto.ts',
      'mock-data/', 'src/main.ts', 'nest-cli.json',
    ]
    return !backendSignals.some(sig => normalized.includes(sig))
  }

  return true
}

// ─── Tool: Parse and write generated files to disk ───────────────────────────

export const writeProjectFiles = createTool({
  id: 'write_project_files',
  description:
    'Parses ---FILE: path--- ... ---END_FILE--- blocks from agent output and writes each file to disk. ' +
    'Set layer to "backend" when writing backend files, "frontend" when writing frontend files. ' +
    'This prevents cross-contamination — backend files will never be written to the frontend dir and vice versa.',
  inputSchema: z.object({
    agentOutput: z
      .string()
      .describe('Raw output from a sub-agent containing ---FILE: ... ---END_FILE--- blocks'),
    baseDir: z
      .string()
      .describe('Base directory to write files into, e.g. ./output/my-app/backend'),
    layer: z
      .enum(['backend', 'frontend', 'all'])
      .describe(
        'Which layer these files belong to. Use "backend" for NestJS output, "frontend" for React/Next.js output. ' +
        'Files that do not match the layer are skipped to avoid cross-contamination.',
      ),
  }),
  execute: async ({ agentOutput, baseDir, layer }) => {
    const resolvedBase = path.resolve(process.cwd(), baseDir)
    fs.mkdirSync(resolvedBase, { recursive: true })

    const fileRegex = /---FILE:\s*(.+?)---\r?\n([\s\S]*?)---END_FILE---/g
    const written: string[] = []
    const skipped: string[] = []
    let match

    while ((match = fileRegex.exec(agentOutput)) !== null) {
      let relativePath = match[1].trim()
      const rawContent = match[2]

      // Strip any layer prefix the LLM included in the path (e.g. "backend/src/main.ts" → "src/main.ts")
      relativePath = relativePath
        .replace(/^backend[/\\]/, '')
        .replace(/^frontend[/\\]/, '')

      // Skip files that don't belong to this layer
      if (!belongsToLayer(relativePath, layer)) {
        skipped.push(relativePath)
        continue
      }

      const content = stripCodeFences(rawContent)

      const absolutePath = path.join(resolvedBase, relativePath)
      const dir = path.dirname(absolutePath)

      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(absolutePath, content, 'utf8')
      written.push(relativePath)
    }

    return {
      filesWritten: written,
      skippedFiles: skipped,
      count: written.length,
      skippedCount: skipped.length,
      baseDir: resolvedBase,
    }
  },
})

// ─── Tool: Create zip archive ────────────────────────────────────────────────

export const createZipArchive = createTool({
  id: 'create_zip_archive',
  description: 'Zips a source directory and writes the archive to an output path. Returns the zip file path.',
  inputSchema: z.object({
    sourceDir: z.string().describe('Directory to zip, e.g. ./output/my-app'),
    outputPath: z.string().describe('Full path for the output .zip file, e.g. ./output/my-app.zip'),
    projectName: z.string().describe('Top-level folder name inside the zip'),
  }),
  execute: async ({ sourceDir, outputPath, projectName }) => {
    const resolvedSource = path.resolve(process.cwd(), sourceDir)
    const resolvedOutput = path.resolve(process.cwd(), outputPath)

    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true })

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(resolvedOutput)
      const archive = archiver('zip', { zlib: { level: 9 } })

      output.on('close', resolve)
      archive.on('error', reject)

      archive.pipe(output)
      archive.directory(resolvedSource, projectName)
      archive.finalize()
    })

    const stats = fs.statSync(resolvedOutput)

    return {
      zipPath: resolvedOutput,
      sizeBytes: stats.size,
      sizeKB: Math.round(stats.size / 1024),
    }
  },
})

// ─── Tool: Read directory tree ───────────────────────────────────────────────

export const readDirectoryTree = createTool({
  id: 'read_directory_tree',
  description: 'Returns a recursive list of all files under a directory.',
  inputSchema: z.object({
    dir: z.string().describe('Directory to scan, e.g. ./output/my-app'),
  }),
  execute: async ({ dir }) => {
    const resolvedDir = path.resolve(process.cwd(), dir)

    const walk = (currentDir: string, prefix = ''): string[] => {
      if (!fs.existsSync(currentDir)) return []
      const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      const lines: string[] = []

      entries.forEach((entry, i) => {
        const isLast = i === entries.length - 1
        const connector = isLast ? '└── ' : '├── '
        lines.push(`${prefix}${connector}${entry.name}`)
        if (entry.isDirectory()) {
          const newPrefix = prefix + (isLast ? '    ' : '│   ')
          lines.push(...walk(path.join(currentDir, entry.name), newPrefix))
        }
      })

      return lines
    }

    const tree = walk(resolvedDir)

    return {
      tree: tree.join('\n'),
      fileCount: tree.filter(l => !l.includes('──')).length,
    }
  },
})