/**
 * Out-parameter for exporters to report rows they could not project.
 *
 * Silently dropping rows is this project's recurring bug class. Exporters take
 * this optional collector rather than changing their return type, which would
 * churn every existing call site for no gain.
 */
export interface ExportStats {
    /** Rows the exporter could not project, for any reason. */
    skipped: number;
}
