-- Available on the pgvector image used by docker-compose. The shared migrations do not
-- create this extension, because CI and local PGlite use stock Postgres without it.
CREATE EXTENSION IF NOT EXISTS vector;
