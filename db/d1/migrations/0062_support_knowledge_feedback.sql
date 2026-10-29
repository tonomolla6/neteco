-- Anonymous feedback facts only: no identity, address, IP, cookie,
-- email, user-agent, free text or invented editorial approval.
CREATE TABLE support_knowledge_feedback (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=64 AND idempotency_key NOT GLOB '*[^0-9a-f]*'),
 page_id TEXT NOT NULL REFERENCES content_pages(id),
 version_id TEXT NOT NULL REFERENCES content_versions(id),
 publication_id TEXT NOT NULL REFERENCES content_publications(id),
 helpful INTEGER NOT NULL CHECK(helpful IN(0,1)),
 response TEXT NOT NULL CHECK(COALESCE(json_valid(response)
  AND json_extract(response,'$.feedbackId')=id AND json_extract(response,'$.pageId')=page_id
  AND json_extract(response,'$.versionId')=version_id AND json_extract(response,'$.helpful')=helpful
  AND json_extract(response,'$.recorded')=1,0)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE INDEX support_knowledge_feedback_article ON support_knowledge_feedback(page_id,version_id,created_at);
CREATE TRIGGER support_knowledge_feedback_current BEFORE INSERT ON support_knowledge_feedback
WHEN NOT EXISTS(SELECT 1 FROM content_publications release
 JOIN content_publication_states head ON head.page_id=release.page_id
 JOIN content_versions version ON version.id=release.version_id AND version.page_id=release.page_id
 WHERE release.id=NEW.publication_id AND release.page_id=NEW.page_id AND release.version_id=NEW.version_id
 AND head.publication_id=release.id AND release.published_at<=NEW.created_at
 AND json_type(version.document,'$.seo.noindex')='false'
 AND json_extract(version.document,'$.supportKnowledge.category') IN('envios','pagos','facturas','devoluciones','cuenta','productos','seguridad')
 AND json_extract(version.document,'$.supportKnowledge.reviewDueAt')>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))
BEGIN SELECT RAISE(ABORT,'knowledge_article_unavailable'); END;
CREATE TRIGGER support_knowledge_feedback_no_update BEFORE UPDATE ON support_knowledge_feedback
BEGIN SELECT RAISE(ABORT,'knowledge_feedback_immutable'); END;
CREATE TRIGGER support_knowledge_feedback_no_delete BEFORE DELETE ON support_knowledge_feedback
BEGIN SELECT RAISE(ABORT,'knowledge_feedback_immutable'); END;
