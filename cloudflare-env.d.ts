declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    ADMIN_KEY?: string;
    BUCKET?: R2Bucket;
  }
}
