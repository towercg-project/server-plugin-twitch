export function registerHttpHandlers(router) {
  router.get("/game/:id", async (req, res, next) => {
    try {
      res.setHeader('Content-Type', 'application/json');
      res.json(this.fetchGameById(req.params.id));
    } catch (e) {
      next(e);
    }
  });

  router.get("/boxart/:id", async (req, res, next) => {
    try {
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ hello: "twitch" }));
    } catch (e) {
      next(e);
    }
  });

  router.get("/game-search/:query", async (req, res, next) => {
    try {
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ hello: "twitch" }));
    } catch (e) {
      next(e);
    }
  });

  router.post("/commercial", async (req, res, next) => {
    try {

    } catch (e) {
      next(e);
    }
  });
}
