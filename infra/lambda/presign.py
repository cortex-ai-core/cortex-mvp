import base64
import os
import re
import boto3

s3 = boto3.client('s3', region_name='us-west-2')

def handler(event, context):
    # Only the authenticated API task role may invoke this function.
    key = event.get('key', '')
    checksum = event.get('checksum', '')
    size = event.get('size', 0)
    if not re.fullmatch(r'[0-9a-f-]{36}/[0-9a-f-]{36}/original\.[a-z0-9]+', key):
        raise ValueError('Invalid document object key')
    if not isinstance(size, int) or size < 1 or size > 50 * 1024 * 1024:
        raise ValueError('Invalid upload size')
    if not re.fullmatch(r'[0-9a-f]{64}', checksum):
        raise ValueError('A SHA-256 checksum is required')
    digest = base64.b64encode(bytes.fromhex(checksum)).decode('ascii')
    content_type = event['contentType']
    url = s3.generate_presigned_url('put_object', Params={
        'Bucket': os.environ['DOCUMENTS_BUCKET'], 'Key': key,
        'ContentLength': size, 'ContentType': content_type, 'ChecksumSHA256': digest,
    }, ExpiresIn=300)
    return {'uploadUrl': url, 'headers': {'Content-Type': content_type, 'x-amz-checksum-sha256': digest}}
