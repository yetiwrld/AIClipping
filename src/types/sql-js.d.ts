declare module 'sql.js' {
  export interface SqlJsDatabase {
    run(sql: string, params?: unknown[]): void
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
    prepare(sql: string): SqlStatement
    export(): Uint8Array
    close(): void
    getRowsModified(): number
  }
  export interface SqlStatement {
    bind(params?: unknown[]): boolean
    step(): boolean
    getAsObject(): Record<string, unknown>
    free(): void
  }
  export interface SqlJsConfig {
    locateFile?(file: string): string
  }
  export interface SqlJsResult extends SqlJsDatabase {
    Database: new (data?: Uint8Array) => SqlJsDatabase
  }
  const initSqlJs: (config?: SqlJsConfig) => Promise<SqlJsResult>
  export default initSqlJs
}
