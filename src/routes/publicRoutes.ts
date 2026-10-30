import { Router } from 'express';
import { wrapperController } from '../controllers/wrapperController';

const router = Router();

router.get('/job/:wrapperId', (req, res, next) =>
  wrapperController.serveWrapper(req, res, next)
);

router.get('/sitemap.xml', (req, res, next) =>
  wrapperController.serveSitemap(req, res, next)
);

router.get('/rss.xml', (req, res, next) =>
  wrapperController.serveRss(req, res, next)
);

router.get('/indexnow.txt', (req, res) =>
  wrapperController.serveIndexNowKey(req, res)
);

router.get('/robots.txt', (req, res) =>
  wrapperController.serveRobots(req, res)
);

export default router;
