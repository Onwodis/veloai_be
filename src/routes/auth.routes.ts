/**
 * /api/v1/auth
 *
 * Password step (answers with a 2FA challenge, never a session):
 *   POST   /register/code               email a 6-digit sign-up code        (rate limited)
 *   POST   /register                    create account (with the code)      (rate limited)
 *   POST   /login                       check password                      (rate limited)
 *
 * Second factor (challenge → session):
 *   POST   /mfa/setup                   QR + secret for first enrolment     (challenge)
 *   POST   /mfa/enroll                  confirm first code → session + recovery codes
 *   POST   /mfa/verify                  TOTP code → session
 *   POST   /mfa/recover                 recovery code → session
 *   POST   /mfa/reset/request           email a 2FA-removal link            (challenge)
 *   POST   /mfa/reset/confirm           consume that link
 *
 * Password recovery:
 *   POST   /password/forgot             email a reset link (same answer for any email)
 *   POST   /password/reset              set a new password from the link
 *
 * Session:
 *   POST   /refresh                     rotate refresh cookie, new access JWT  (cookie + CSRF header)
 *   POST   /logout                      end current session                    (cookie + CSRF header)
 *   GET    /me                          current user                           (bearer)
 *   GET    /sessions                    active sessions                        (bearer)
 *   DELETE /sessions/:sessionId         revoke one session                     (bearer)
 *   POST   /sessions/revoke-others      sign out everywhere else               (bearer)
 *   GET    /mfa/recovery-codes          remaining recovery codes               (bearer)
 *   POST   /mfa/recovery-codes          regenerate (needs a TOTP code)         (bearer)
 */
import { Router } from 'express';
import * as auth from '../controllers/auth.controller.js';
import { authenticate, optionalAuthenticate, requireAuth } from '../middleware/authenticate.js';
import { loginAccountLimiter, loginLimiter, mfaLimiter, recoveryLimiter, refreshLimiter, registerLimiter, signupCodeLimiter } from '../middleware/rateLimit.js';
import { requireCsrfHeader } from '../middleware/security.js';
import { validate, validBody } from '../middleware/validate.js';
import * as emailVerification from '../services/emailVerification.service.js';
import {
  emailTokenSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaChallengeSchema,
  mfaCodeSchema,
  mfaRecoverySchema,
  regenerateCodesSchema,
  registerSchema,
  signupCodeSchema,
  resetPasswordSchema,
  sessionParamsSchema,
} from '../models/auth.schemas.js';

export const authRouter: Router = Router();

authRouter.post('/register/code', signupCodeLimiter, validate({ body: signupCodeSchema }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await emailVerification.sendSignupCode(validBody(req, signupCodeSchema).email));
});
authRouter.post('/register', registerLimiter, validate({ body: registerSchema }), auth.register);
authRouter.post('/login', loginLimiter, validate({ body: loginSchema }), loginAccountLimiter, auth.login);

authRouter.post('/mfa/setup', mfaLimiter, validate({ body: mfaChallengeSchema }), auth.mfaSetup);
authRouter.post('/mfa/enroll', mfaLimiter, validate({ body: mfaCodeSchema }), auth.mfaEnroll);
authRouter.post('/mfa/verify', mfaLimiter, validate({ body: mfaCodeSchema }), auth.mfaVerify);
authRouter.post('/mfa/recover', mfaLimiter, validate({ body: mfaRecoverySchema }), auth.mfaRecover);
authRouter.post('/mfa/reset/request', recoveryLimiter, validate({ body: mfaChallengeSchema }), auth.mfaResetRequest);
authRouter.post('/mfa/reset/confirm', recoveryLimiter, validate({ body: emailTokenSchema }), auth.mfaResetConfirm);

authRouter.post('/password/forgot', recoveryLimiter, validate({ body: forgotPasswordSchema }), auth.forgotPassword);
authRouter.post('/password/reset', recoveryLimiter, validate({ body: resetPasswordSchema }), auth.resetPassword);

authRouter.post('/refresh', refreshLimiter, requireCsrfHeader, auth.refresh);
// The access token (if any) identifies the session when the cookie is gone.
authRouter.post('/logout', requireCsrfHeader, optionalAuthenticate, auth.logout);

authRouter.get('/me', authenticate, auth.me);

/* Email verification (services/emailVerification.service.ts): the welcome tokens and the trial wait for it. */
authRouter.post('/email/verify', recoveryLimiter, validate({ body: emailTokenSchema }), async (req, res) => {
  res.json(await emailVerification.verifyEmail(validBody(req, emailTokenSchema).token));
});
authRouter.get('/email/status', authenticate, async (req, res) => {
  res.json(await emailVerification.verificationStatus(requireAuth(req).userId));
});
authRouter.post('/email/resend', recoveryLimiter, authenticate, async (req, res) => {
  const userId = requireAuth(req).userId;
  await emailVerification.sendVerification(userId);
  res.json(await emailVerification.verificationStatus(userId));
});
authRouter.get('/sessions', authenticate, auth.listSessions);
authRouter.post('/sessions/revoke-others', authenticate, auth.revokeOtherSessions);
authRouter.delete(
  '/sessions/:sessionId',
  authenticate,
  validate({ params: sessionParamsSchema }),
  auth.revokeSession,
);
authRouter.get('/mfa/recovery-codes', authenticate, auth.recoveryCodes);
authRouter.post(
  '/mfa/recovery-codes',
  authenticate,
  mfaLimiter,
  validate({ body: regenerateCodesSchema }),
  auth.regenerateRecoveryCodes,
);
