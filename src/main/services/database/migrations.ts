import type { AppDatabase } from './db'

/**
 * Forward-only migrations. Never destructive — changing an existing column
 * requires an additive migration that preserves data.
 */

export interface Migration {
  version: number
  name: string
  up: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'file',
  source_path TEXT,
  source_url TEXT,
  source_filename TEXT,
  duration REAL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  has_audio INTEGER NOT NULL DEFAULT 0,
  video_codec TEXT,
  audio_codec TEXT,
  size_bytes INTEGER,
  rotation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'created',
  status_message TEXT,
  settings TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  confidence REAL,
  words TEXT
);
CREATE INDEX IF NOT EXISTS idx_segments_project ON transcript_segments(project_id, start_time);

CREATE TABLE IF NOT EXISTS clip_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  start_segment_id INTEGER NOT NULL,
  end_segment_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  hook TEXT NOT NULL DEFAULT '',
  transcript_excerpt TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  clip_type TEXT NOT NULL DEFAULT 'other',
  scores TEXT,
  overall_score INTEGER,
  score_explanation TEXT,
  provider TEXT NOT NULL DEFAULT 'heuristic-local',
  moment_key TEXT NOT NULL DEFAULT '',
  rank_in_moment INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'discovered',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_project ON clip_candidates(project_id, status);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES clip_candidates(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  aspect_ratio TEXT NOT NULL DEFAULT '9:16',
  crop_mode TEXT NOT NULL DEFAULT 'center',
  crop_x REAL NOT NULL DEFAULT 0.5,
  zoom REAL NOT NULL DEFAULT 1.0,
  caption_style_id TEXT NOT NULL DEFAULT 'classic',
  caption_overrides TEXT NOT NULL DEFAULT '{}',
  caption_text_edits TEXT NOT NULL DEFAULT '{}',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  hashtags TEXT NOT NULL DEFAULT '[]',
  cta TEXT NOT NULL DEFAULT '',
  metadata_provider TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id);

CREATE TABLE IF NOT EXISTS renders (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  output_path TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  stage TEXT,
  error TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_renders_project ON renders(project_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  project_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  stage TEXT,
  progress REAL,
  message TEXT,
  error TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state, updated_at);

CREATE TABLE IF NOT EXISTS speakers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  name TEXT,
  color TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
  },
  {
    version: 2,
    name: 'clip output settings, silence cuts, cue edits, render previews',
    up: `
ALTER TABLE clips ADD COLUMN caption_cue_splits TEXT NOT NULL DEFAULT '{}';
ALTER TABLE clips ADD COLUMN caption_cue_merges TEXT NOT NULL DEFAULT '{}';
ALTER TABLE clips ADD COLUMN caption_timing_offsets TEXT NOT NULL DEFAULT '{}';
ALTER TABLE clips ADD COLUMN silence_cuts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE clips ADD COLUMN output_resolution TEXT NOT NULL DEFAULT '1080p';
ALTER TABLE clips ADD COLUMN output_quality TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE clips ADD COLUMN output_fps TEXT NOT NULL DEFAULT 'source';
ALTER TABLE renders ADD COLUMN preview INTEGER NOT NULL DEFAULT 0;
`
  }
]

export function runMigrations(db: AppDatabase): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  const applied = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version))
  let current = 0
  for (const migration of MIGRATIONS.sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) {
      current = migration.version
      continue
    }
    db.transaction(() => {
      db.exec(migration.up)
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        new Date().toISOString()
      ])
    })
    current = migration.version
  }
  return current
}

export function schemaVersion(db: AppDatabase): number {
  const row = db.get<{ version: number }>('SELECT MAX(version) as version FROM schema_migrations')
  return row?.version ?? 0
}
