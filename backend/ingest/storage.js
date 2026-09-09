// =============================================================
//  Supabase Storage helpers for original files and parsed output.
//  Layout: <bucket>/<namespace>/<document_id>/original.<ext>
//          <bucket>/<namespace>/<document_id>/parsed.md
// =============================================================

export const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "documents";

export function documentPrefix(namespace, documentId) {
  return `${namespace}/${documentId}`;
}

export function originalPath(namespace, documentId, ext) {
  return `${documentPrefix(namespace, documentId)}/original${ext}`;
}

export function parsedPath(namespace, documentId) {
  return `${documentPrefix(namespace, documentId)}/parsed.md`;
}

/** PDF rendition of an Office original, used by the in-browser viewer. */
export function renditionPath(namespace, documentId) {
  return `${documentPrefix(namespace, documentId)}/rendition.pdf`;
}

export async function uploadObject(supabase, path, body, contentType) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed for ${path}: ${error.message}`);
  return path;
}

export async function downloadObject(supabase, path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`Storage download failed for ${path}: ${error?.message || "no data"}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Remove every object under a document's prefix. Best-effort; returns count removed. */
export async function deletePrefix(supabase, prefix) {
  const { data: entries, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 100 });
  if (error || !entries?.length) return 0;
  const paths = entries.map((e) => `${prefix}/${e.name}`);
  const { error: rmErr } = await supabase.storage.from(BUCKET).remove(paths);
  if (rmErr) throw new Error(`Storage delete failed for ${prefix}: ${rmErr.message}`);
  return paths.length;
}

export async function signedUrl(supabase, path, seconds = 300) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds);
  if (error || !data?.signedUrl) throw new Error(`Could not sign ${path}: ${error?.message || "no url"}`);
  return data.signedUrl;
}
