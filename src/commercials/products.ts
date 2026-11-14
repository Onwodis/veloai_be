/**
 * Products: what a company advertises. Details, USPs and audience feed the
 * director's script; photos / logo / packshots / videos are the visual truth
 * every ad must stay faithful to. Uploads go straight to the bucket (signed
 * PUT) and count against the uploader's storage like any other upload.
 */
import type { AuthContext } from '../middleware/authenticate.js';
import { deleteObject, deletePrefix, headObject, presignPut, readUrl } from '../services/storage.service.js';
import { trackUpload } from '../storage/ledger.js';
import { assertStorage } from '../storage/service.js';
import { sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { companyAccess } from './companies.js';
import type { ProductInput } from './schemas.js';

export interface ProductRow {
  id: string;
  companyId: string;
  name: string;
  category: string;
  description: string;
  price: string | null;
  usps: string[];
  audience: Record<string, string>;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductAssetRow {
  id: string;
  productId: string;
  kind: 'PHOTO' | 'LOGO' | 'PACKSHOT' | 'VIDEO';
  key: string;
  name: string;
  contentType: string;
  size: string;
  status: 'PENDING' | 'READY';
  createdById: string | null;
  createdAt: Date;
}

const productFolder = (workspaceId: string, companyId: string, productId: string): string => `workspaces/${workspaceId}/companies/${companyId}/products/${productId}`;

export async function loadProduct(companyId: string, productId: string): Promise<ProductRow> {
  const [row] = await sql<ProductRow[]>`SELECT * FROM products WHERE id = ${productId} AND company_id = ${companyId} AND deleted_at IS NULL`;
  if (!row) throw AppError.notFound('Product');
  return row;
}

async function assetView(asset: ProductAssetRow) {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    contentType: asset.contentType,
    size: Number(asset.size),
    status: asset.status,
    url: asset.status === 'READY' ? await readUrl(asset.key) : null,
    createdById: asset.createdById,
    createdAt: asset.createdAt.toISOString(),
  };
}

export async function productView(row: ProductRow) {
  const [assets, ads] = await Promise.all([
    sql<ProductAssetRow[]>`SELECT * FROM product_assets WHERE product_id = ${row.id} ORDER BY created_at`,
    sql<{ id: string; title: string; stage: string; status: string; lengthSec: number; updatedAt: Date; thumbKey: string | null }[]>`
      SELECT s.id, s.title, a.stage, s.status, a.length_sec, s.updated_at,
        COALESCE(s.thumb_key, (SELECT t.thumb_key FROM studio_takes t WHERE t.project_id = s.id AND t.status = 'READY' ORDER BY t.created_at DESC LIMIT 1)) AS thumb_key
      FROM ad_projects a JOIN studio_projects s ON s.id = a.project_id
      WHERE a.product_id = ${row.id} AND s.deleted_at IS NULL ORDER BY s.updated_at DESC`,
  ]);
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    category: row.category,
    description: row.description,
    price: row.price,
    usps: row.usps,
    audience: row.audience,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    assets: await Promise.all(assets.map(assetView)),
    ads: await Promise.all(
      ads.map(async (ad) => ({
        id: ad.id,
        title: ad.title,
        stage: ad.stage,
        status: ad.status,
        lengthSec: ad.lengthSec,
        updatedAt: ad.updatedAt.toISOString(),
        thumbUrl: ad.thumbKey ? await readUrl(ad.thumbKey) : null,
      })),
    ),
  };
}

export async function listProducts(auth: AuthContext, workspaceId: string, companyId: string) {
  await companyAccess(auth, workspaceId, companyId, false);
  const rows = await sql<(ProductRow & { ads: number; coverKey: string | null })[]>`
    SELECT p.*,
      (SELECT count(*)::int FROM ad_projects a JOIN studio_projects s ON s.id = a.project_id WHERE a.product_id = p.id AND s.deleted_at IS NULL) AS ads,
      (SELECT pa.key FROM product_assets pa WHERE pa.product_id = p.id AND pa.status = 'READY' AND pa.kind IN ('PACKSHOT', 'PHOTO') ORDER BY pa.created_at LIMIT 1) AS cover_key
    FROM products p WHERE p.company_id = ${companyId} AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`;
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      price: row.price,
      ads: row.ads,
      coverUrl: row.coverKey ? await readUrl(row.coverKey) : null,
      updatedAt: row.updatedAt.toISOString(),
    })),
  );
}

export async function createProduct(auth: AuthContext, workspaceId: string, companyId: string, input: ProductInput) {
  await companyAccess(auth, workspaceId, companyId, true);
  const [row] = await sql<ProductRow[]>`
    INSERT INTO products (company_id, name, category, description, price, usps, audience, created_by_id)
    VALUES (${companyId}, ${input.name}, ${input.category ?? ''}, ${input.description ?? ''}, ${input.price || null}, ${input.usps ?? []}::text[],
      ${sql.json(input.audience ?? {})}, ${auth.userId})
    RETURNING *`;
  return productView(row!);
}

export async function getProduct(auth: AuthContext, workspaceId: string, companyId: string, productId: string) {
  await companyAccess(auth, workspaceId, companyId, false);
  return productView(await loadProduct(companyId, productId));
}

export async function updateProduct(auth: AuthContext, workspaceId: string, companyId: string, productId: string, input: Partial<ProductInput>) {
  await companyAccess(auth, workspaceId, companyId, true);
  const current = await loadProduct(companyId, productId);
  const [row] = await sql<ProductRow[]>`
    UPDATE products SET name = ${input.name ?? current.name}, category = ${input.category ?? current.category}, description = ${input.description ?? current.description},
      price = ${input.price === undefined ? current.price : input.price || null}, usps = ${input.usps ?? current.usps}::text[],
      audience = ${sql.json(input.audience ?? current.audience)}, updated_at = now()
    WHERE id = ${productId} RETURNING *`;
  return productView(row!);
}

export async function deleteProduct(auth: AuthContext, workspaceId: string, companyId: string, productId: string): Promise<void> {
  await companyAccess(auth, workspaceId, companyId, true);
  await loadProduct(companyId, productId);
  await sql`UPDATE products SET deleted_at = now() WHERE id = ${productId}`;
  await sql`UPDATE studio_projects SET deleted_at = now() WHERE id IN (SELECT project_id FROM ad_projects WHERE product_id = ${productId}) AND deleted_at IS NULL`;
}

/* ------------------------------------------------------------------ assets */

export async function createProductAsset(
  auth: AuthContext,
  workspaceId: string,
  companyId: string,
  productId: string,
  input: { kind: ProductAssetRow['kind']; fileName: string; contentType: string; size: number },
) {
  await companyAccess(auth, workspaceId, companyId, true);
  await loadProduct(companyId, productId);
  await assertStorage(auth, input.size, 'this upload');
  const [asset] = await sql<ProductAssetRow[]>`
    INSERT INTO product_assets (product_id, kind, name, content_type, size, created_by_id)
    VALUES (${productId}, ${input.kind}, ${input.fileName}, ${input.contentType}, ${input.size}, ${auth.userId}) RETURNING *`;
  const safe = input.fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  const key = `${productFolder(workspaceId, companyId, productId)}/${asset!.id}-${safe}`;
  await sql`UPDATE product_assets SET key = ${key} WHERE id = ${asset!.id}`;
  return { asset: await assetView({ ...asset!, key }), uploadUrl: await presignPut(key, input.contentType) };
}

export async function completeProductAsset(auth: AuthContext, workspaceId: string, companyId: string, productId: string, assetId: string) {
  await companyAccess(auth, workspaceId, companyId, true);
  const [asset] = await sql<ProductAssetRow[]>`SELECT * FROM product_assets WHERE id = ${assetId} AND product_id = ${productId}`;
  if (!asset) throw AppError.notFound('File');
  const head = await headObject(asset.key);
  if (!head) throw AppError.badRequest('The file has not finished uploading.');
  if (head.size !== Number(asset.size)) throw AppError.badRequest('The uploaded file size does not match. Upload it again.');
  await trackUpload(asset.key, head.size, async () => {
    await sql`DELETE FROM product_assets WHERE id = ${assetId}`;
    await deleteObject(asset.key);
  });
  await sql`UPDATE product_assets SET status = 'READY' WHERE id = ${assetId}`;
  await sql`UPDATE products SET updated_at = now() WHERE id = ${productId}`;
  return getProduct(auth, workspaceId, companyId, productId);
}

export async function deleteProductAsset(auth: AuthContext, workspaceId: string, companyId: string, productId: string, assetId: string) {
  await companyAccess(auth, workspaceId, companyId, true);
  const [asset] = await sql<ProductAssetRow[]>`DELETE FROM product_assets WHERE id = ${assetId} AND product_id = ${productId} RETURNING *`;
  if (asset?.key) await deleteObject(asset.key);
  return getProduct(auth, workspaceId, companyId, productId);
}

/** Bucket clean-up when a product is purged for good (not on soft delete). */
export async function purgeProductFiles(workspaceId: string, companyId: string, productId: string): Promise<void> {
  await deletePrefix(`${productFolder(workspaceId, companyId, productId)}/`);
}
