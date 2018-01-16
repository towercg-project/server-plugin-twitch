export default function registerHttpHandlers(router) {
  router.get("/boxart/:id", async (req, res, next) => {
    try {
      res.json({ hello: "twitch" });
    } catch (e) {
      next(e);
    }
  });

  router.get("/game-search/:query", async (req, res, next) => {
    try {
      const result =
        await this.twitch.games.searchGames(req.params.query, !!req.params.live);

      res.json(result);
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
