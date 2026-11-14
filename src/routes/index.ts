/**
 * Root API router. Versioned under /api/v1; health probes sit outside the
 * version prefix so infrastructure config never changes with API versions.
 */
import { Router } from 'express';
import * as health from '../controllers/health.controller.js';
import { adminRouter, analyticsRouter } from './admin.routes.js';
import { aiRouter } from './ai.routes.js';
import { authRouter } from './auth.routes.js';
import { billingRouter, workspaceBillingRouter } from './billing.routes.js';
import { engineRouter, projectRouter } from './project.routes.js';
import { avatarRouter, profileRouter } from './profile.routes.js';
import { systemRouter } from './system.routes.js';
import { adminBrandingRouter, publicBrandingRouter } from './branding.routes.js';
import { layoutRouter } from './layout.routes.js';
import { adminTokenRouter, paymentRouter, workspaceTokenRouter } from './token.routes.js';
import { adminStudioRouter, studioRouter } from '../studio/routes.js';
import { userRouter } from './user.routes.js';
import { creationRouter, workspaceCreationRouter } from '../creations/routes.js';
import { likenessRouter } from '../likeness/routes.js';
import { adminStorageRouter, storageRouter } from '../storage/routes.js';
import { credentialsRouter } from '../vault/routes.js';
import { launchRouter } from '../launch/routes.js';
import { musicVideoRouter } from '../musicvideo/routes.js';
import { adRouter, companyRouter } from '../commercials/routes.js';
import { movesRouter, sceneMovesRouter } from '../moves/routes.js';
import { adminSupportRouter, adminUserRouter, commandCenterRouter, supportRouter } from '../admin360/routes.js';

export const healthRouter: Router = Router();
healthRouter.get('/live', health.live);
healthRouter.get('/ready', health.ready);

export const apiRouter: Router = Router();
apiRouter.use('/auth', authRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/me/layouts', layoutRouter);
apiRouter.use('/me', profileRouter);
apiRouter.use('/avatars', avatarRouter);
apiRouter.use('/billing', billingRouter);
apiRouter.use('/analytics', analyticsRouter);
apiRouter.use('/admin/tokens', adminTokenRouter);
apiRouter.use('/admin/engines', engineRouter);
apiRouter.use('/admin/ai', aiRouter);
apiRouter.use('/admin/system', systemRouter);
apiRouter.use('/workspaces/:workspaceId/projects', projectRouter);
apiRouter.use('/workspaces/:workspaceId/studio', studioRouter);
apiRouter.use('/workspaces/:workspaceId/music-videos', musicVideoRouter);
apiRouter.use('/workspaces/:workspaceId/companies', companyRouter);
apiRouter.use('/workspaces/:workspaceId/ads', adRouter);
apiRouter.use('/workspaces/:workspaceId/scene-moves', sceneMovesRouter);
apiRouter.use('/moves', movesRouter);
apiRouter.use('/admin/studio', adminStudioRouter);
apiRouter.use('/admin/storage', adminStorageRouter);
apiRouter.use('/admin/credentials', credentialsRouter);
apiRouter.use('/admin/launch', launchRouter);
apiRouter.use('/likeness', likenessRouter);
apiRouter.use('/storage', storageRouter);
apiRouter.use('/creations', creationRouter);
apiRouter.use('/workspaces/:workspaceId/creations', workspaceCreationRouter);
apiRouter.use('/admin/command-center', commandCenterRouter);
apiRouter.use('/admin/users', adminUserRouter);
apiRouter.use('/admin/support', adminSupportRouter);
apiRouter.use('/support', supportRouter);
apiRouter.use('/public/branding', publicBrandingRouter);
apiRouter.use('/admin/branding', adminBrandingRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/workspaces/:workspaceId/tokens', workspaceTokenRouter);
apiRouter.use('/payments', paymentRouter);
apiRouter.use('/workspaces/:workspaceId/billing', workspaceBillingRouter);
