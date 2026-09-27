import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Generates the deterministic media + transcript fixtures used by integration
 * tests (gitignored — run `npm run fixtures` after checkout).
 *
 *   tests/fixtures/media/sample.mp4      — 60s 1280x720 landscape test video
 *   tests/fixtures/media/silence.mp4     — 8.5s tone/silence/tone (2.5s gap) for silencedetect tests
 *   tests/fixtures/transcript.json       — word-level transcript matching the video duration
 *
 * The transcript is scaled to exactly the video duration with a realistic
 * speaking pace (~2.4 words/sec) so the heuristic analyzer finds windows.
 */

const FFMPEG = require('@ffmpeg-installer/ffmpeg').path as string
const FFPROBE = require('@ffprobe-installer/ffprobe').path as string

const VIDEO_SECONDS = 60

const OUT_MEDIA = path.resolve(__dirname, '..', 'tests', 'fixtures', 'media')
const OUT_TRANSCRIPT = path.resolve(__dirname, '..', 'tests', 'fixtures', 'transcript.json')

async function makeVideo(): Promise<string> {
  fs.mkdirSync(OUT_MEDIA, { recursive: true })
  const target = path.join(OUT_MEDIA, 'sample.mp4')
  // A landscape video with an audio tone and burned-in timecode (so clips are
  // visually distinguishable), fully deterministic.
  const vf = [
    'testsrc2=size=1280x720:rate=30',
    "drawtext=text='t %{pts\\:hms}':x=40:y=40:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.5"
  ].join(',')
  await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', vf,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', String(VIDEO_SECONDS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    target
  ])
  const probe = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', target])
  const duration = JSON.parse(probe.stdout).format?.duration
  console.log(`sample.mp4 — ${duration}s`)
  return target
}

function makeTranscript(): void {
  // 24 sentences × 6 words = 144 words in 60s → 2.4 words/sec (realistic pace;
  // the heuristic scanner expects 2.1–3.6 wps for speech density).
  const sentences = [
    'Why do most creators fail early',
    'I made every mistake possible myself',
    'And the results honestly shocked me',
    'The first thing is brutal consistency',
    'Most people completely ignore this part',
    'Then everything changed when I committed',
    'Because accountability compounds faster than talent',
    'Within two weeks you feel different',
    'Here is the exact framework I use',
    'Step one is deceptively simple friends',
    'You write down every single commitment',
    'Then you ruthlessly cut the bottom',
    'That alone doubled my output last year',
    'Step two is where it gets interesting',
    'You batch similar tasks into blocks',
    'No context switching whatsoever after that',
    'This sounds boring but it compounds',
    'Within a month the difference is huge',
    'Step three is the real secret',
    'You review your week every Friday',
    'Twenty minutes just you and coffee',
    'Ask what actually moved the needle',
    'Then do more of that next week',
    'Thanks for watching see you soon'
  ]

  // Build provisional timings, then scale to exactly VIDEO_SECONDS.
  const words: Array<{ word: string; start: number; end: number }> = []
  let t = 0
  for (const sentence of sentences) {
    for (const word of sentence.split(' ')) {
      const dur = 0.24 + Math.min(0.18, word.length * 0.025)
      words.push({ word, start: t, end: t + dur })
      t += dur + 0.05
    }
    t += 0.4 // sentence gap
  }
  const scale = VIDEO_SECONDS / t
  for (const w of words) {
    w.start = +(w.start * scale).toFixed(3)
    w.end = +(w.end * scale).toFixed(3)
  }

  // 8 words per segment → segments carry their own word timings (schema shape)
  const segments = words.reduce<Array<{ start: number; end: number; text: string; id: number; words: typeof words }>>(
    (acc, w, i) => {
      const segIndex = Math.floor(i / 8)
      const seg = acc[segIndex] ?? { start: w.start, end: w.end, text: '', id: segIndex, words: [] }
      seg.end = w.end
      seg.text += (seg.text ? ' ' : '') + w.word
      seg.words.push(w)
      acc[segIndex] = seg
      return acc
    },
    []
  )

  const transcript = {
    language: 'en',
    duration: VIDEO_SECONDS,
    segments
  }
  fs.mkdirSync(path.dirname(OUT_TRANSCRIPT), { recursive: true })
  fs.writeFileSync(OUT_TRANSCRIPT, JSON.stringify(transcript, null, 2))
  const wps = (words.length / VIDEO_SECONDS).toFixed(2)
  console.log(`transcript.json — ${words.length} words, ${segments.length} segments, ${VIDEO_SECONDS}s (${wps} wps)`)
}

/** tone(3s) → silence(2.5s) → tone(3s): a known gap for silencedetect tests. */
async function makeSilenceVideo(): Promise<void> {
  const target = path.join(OUT_MEDIA, 'silence.mp4')
  await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono,atrim=duration=2.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-f', 'lavfi', '-i', 'testsrc=duration=8.5:size=640x360:rate=30',
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]',
    '-map', '3:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100',
    '-shortest',
    target
  ])
  console.log('silence.mp4 — 8.5s (tone 3s → silence 2.5s → tone 3s)')
}

async function main(): Promise<void> {
  await makeVideo()
  await makeSilenceVideo()
  makeTranscript()
  console.log('\nFixtures ready in tests/fixtures/')
}

void main().catch((err) => {
  console.error('Fixture generation failed:', err.message)
  process.exit(1)
})
