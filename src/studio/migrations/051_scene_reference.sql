-- A scene's reference video (studio/sceneReference.ts): the creator uploads a clip of what they want;
-- the director describes its action, blocking and camera, and every take of the scene re-makes it
-- clean and professional. { assetId, status: ANALYSING|READY|FAILED, brief, error, at }
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS reference jsonb;
