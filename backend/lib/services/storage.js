import {
  S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Same helper contract and object keys as the existing document storage code.
// No Supabase storage fallback: an AWS upload must never write to the source.
export function createS3Storage(env = process.env, client = new S3Client({ region: env.AWS_REGION || "us-east-2" })) {
  return {
    from() {
      const bucket = env.S3_DOCUMENTS_BUCKET;
      const run = async (action) => {
        if (!bucket) return { data: null, error: { message: "S3_DOCUMENTS_BUCKET is not configured." } };
        try { return { data: await action(), error: null }; }
        catch { return { data: null, error: { message: "S3 operation failed." } }; }
      };
      return {
        upload: (path, body, options = {}) => run(async () => {
          await client.send(new PutObjectCommand({ Bucket: bucket, Key: path, Body: body, ContentType: options.contentType }));
          return { path };
        }),
        download: (path) => run(async () => {
          const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: path }));
          const bytes = await result.Body.transformToByteArray();
          return new Blob([bytes]);
        }),
        list: (prefix, { limit = 100 } = {}) => run(async () => {
          const result = await client.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: `${prefix}/`, Delimiter: "/", MaxKeys: limit,
          }));
          return (result.Contents || []).map(({ Key }) => ({ name: Key.slice(prefix.length + 1) }));
        }),
        remove: (paths) => run(async () => {
          if (!paths.length) return [];
          const result = await client.send(new DeleteObjectsCommand({
            Bucket: bucket, Delete: { Objects: paths.map((Key) => ({ Key })), Quiet: true },
          }));
          if (result.Errors?.length) throw new Error("Some S3 objects were not deleted.");
          return paths.map((name) => ({ name }));
        }),
        createSignedUrl: (path, seconds) => run(async () => ({
          signedUrl: await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: path }), { expiresIn: seconds }),
        })),
      };
    },
  };
}
