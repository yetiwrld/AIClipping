import type { CaptionCue } from './segmentation'
import { formatSrtTime } from '../utils/time'

/** SRT export (for platforms that accept caption files). */
export function buildSrtDocument(cues: CaptionCue[]): string {
  return (
    cues
      .map((cue, i) => {
        const time = `${formatSrtTime(cue.startTime)} --> ${formatSrtTime(cue.endTime)}`
        return `${i + 1}\n${time}\n${cue.lines.join('\n')}`
      })
      .join('\n\n') + '\n'
  )
}
