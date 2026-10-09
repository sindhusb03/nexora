import type {
  BulkAcceptRequest,
  Exception,
  ExtractedValue,
  ExtractionJob,
  IngestionResult,
  ResolveRequest,
  UploadRequest,
} from "@nexora/contracts";

/**
 * Typed ingestion client. The HTTP implementation talks to `/ingestion/*`.
 * The mock implementation serves the India and US fixture pack.
 * `client.ts` is the only place that chooses between them.
 *
 * Writes take the session CSRF token. Resolve and bulk-accept also take roles.
 * The HTTP client sends the token and lets the API enforce the role.
 * The mock enforces the role because it has no session.
 */
export interface IngestionClient {
  upload(input: UploadRequest, csrfToken: string): Promise<IngestionResult<ExtractionJob>>;
  getJob(jobId: string): Promise<IngestionResult<ExtractionJob>>;
  getValues(jobId: string): Promise<IngestionResult<readonly ExtractedValue[]>>;
  getExceptions(jobId: string): Promise<IngestionResult<readonly Exception[]>>;
  resolve(
    exceptionId: string,
    request: ResolveRequest,
    actorId: string,
    roles: readonly string[],
    csrfToken: string,
  ): Promise<IngestionResult<Exception>>;
  bulkAccept(
    request: BulkAcceptRequest,
    actorId: string,
    roles: readonly string[],
    csrfToken: string,
  ): Promise<IngestionResult<readonly Exception[]>>;
}
