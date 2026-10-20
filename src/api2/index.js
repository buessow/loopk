import express from 'express';
import { MANAGE_ACCESS } from '../auth/index.js';

/**
 * APIv2 authorization: token exchange used by AAPS (GET /authorization/request/:accessToken)
 * and administration of subjects (access tokens), for admins only.
 */
export function createApi2 (ctx) {
  const { auth } = ctx;
  const router = express.Router();
  router.use(express.json());

  const h = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  router.get('/authorization/request/:accessToken', (req, res) => {
    const authorized = auth.authorize(req.params.accessToken);
    if (!authorized) return res.status(401).json({ status: 401, message: 'Unauthorized', description: 'Invalid/Missing' });
    res.json(authorized);
  });

  const subjectJson = (s) => ({
    _id: String(s.id), name: s.name, canWrite: s.can_write, canUploadModel: s.can_upload_model, notes: s.notes, accessToken: s.access_token, created_at: s.created_at,
  });
  const admin = auth.require(MANAGE_ACCESS);
  const notBoolean = (v) => v !== undefined && typeof v !== 'boolean';
  const badFlags = (body) => (notBoolean(body?.canWrite) && 'canWrite') || (notBoolean(body?.canUploadModel) && 'canUploadModel');

  router.get('/authorization/subjects', admin, (req, res) => {
    res.json(auth.subjects.map(subjectJson));
  });
  router.post('/authorization/subjects', admin, h(async (req, res) => {
    const { name, canWrite = false, canUploadModel = false, notes = null } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ status: 400, message: 'name is required' });
    const bad = badFlags(req.body);
    if (bad) return res.status(400).json({ status: 400, message: `${bad} must be true or false` });
    try {
      res.json(subjectJson(await auth.createSubject({ name: name.trim(), canWrite, canUploadModel, notes })));
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ status: 409, message: 'Name already exists' });
      throw err;
    }
  }));
  router.put('/authorization/subjects/:id?', admin, h(async (req, res) => {
    const id = req.params.id || req.body?._id;
    const bad = badFlags(req.body);
    if (bad) return res.status(400).json({ status: 400, message: `${bad} must be true or false` });
    const updated = await auth.updateSubject(id, req.body || {});
    if (!updated) return res.status(404).json({ status: 404, message: 'Not found' });
    res.json(subjectJson(updated));
  }));
  router.delete('/authorization/subjects/:id', admin, h(async (req, res) => {
    res.json({ ok: await auth.deleteSubject(req.params.id) });
  }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ status: 500, message: 'Internal Server Error' });
  });

  return router;
}
