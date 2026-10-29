-- Immutable request intentions only: no deletion or automatic retention decision.
CREATE TABLE account_privacy_requests (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND lower(replace(id,'-','')) NOT GLOB '*[^0-9a-f]*' AND substr(id,15,1) IN('1','2','3','4','5','6','7','8') AND lower(substr(id,20,1)) IN('8','9','a','b')),
 customer_id TEXT NOT NULL REFERENCES customers(id), actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL CHECK(session_version>=1),
 command_id TEXT NOT NULL CHECK(length(command_id)=36 AND substr(command_id,9,1)='-' AND substr(command_id,14,1)='-' AND substr(command_id,19,1)='-' AND substr(command_id,24,1)='-' AND length(replace(command_id,'-',''))=32 AND lower(replace(command_id,'-','')) NOT GLOB '*[^0-9a-f]*' AND substr(command_id,15,1) IN('1','2','3','4','5','6','7','8') AND lower(substr(command_id,20,1)) IN('8','9','a','b')),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 request_type TEXT NOT NULL CHECK(request_type IN('export','anonymize')),status TEXT NOT NULL CHECK(status IN('completed','requested')),
 requested_at TEXT NOT NULL CHECK(length(requested_at)=20 AND requested_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',requested_at),'')),
 due_at TEXT NOT NULL CHECK(length(due_at)=20 AND due_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',due_at),'') AND due_at=strftime('%Y-%m-%dT%H:%M:%SZ',requested_at,'+30 days')),
 completed_at TEXT CHECK(completed_at IS NULL OR (length(completed_at)=20 AND completed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',completed_at),''))),
 CHECK((request_type='export' AND status='completed' AND completed_at IS NOT NULL AND completed_at=requested_at) OR (request_type='anonymize' AND status='requested' AND completed_at IS NULL)),UNIQUE(customer_id,command_id)
) STRICT;
CREATE INDEX account_privacy_owner_time ON account_privacy_requests(customer_id,requested_at DESC,id DESC);
CREATE TRIGGER account_privacy_no_update BEFORE UPDATE ON account_privacy_requests BEGIN SELECT RAISE(ABORT,'privacy_immutable'); END;
CREATE TRIGGER account_privacy_no_delete BEFORE DELETE ON account_privacy_requests BEGIN SELECT RAISE(ABORT,'privacy_immutable'); END;
CREATE TRIGGER account_privacy_authority BEFORE INSERT ON account_privacy_requests WHEN NOT EXISTS(
 SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id JOIN customers c ON c.id=i.customer_id
 WHERE s.id=NEW.session_id AND i.id=NEW.actor_id AND c.id=NEW.customer_id AND c.status='active'
 AND s.session_version=NEW.session_version AND i.session_version=s.session_version AND i.status='active'
 AND s.revoked_at IS NULL AND s.created_at<=NEW.requested_at AND s.expires_at>max(NEW.requested_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.requested_at
) BEGIN SELECT RAISE(ABORT,'privacy_authority'); END;
