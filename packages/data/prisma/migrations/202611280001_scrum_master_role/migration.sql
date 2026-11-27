ALTER TABLE public."AccessGrant"
  DROP CONSTRAINT "AccessGrant_role_check",
  ADD CONSTRAINT "AccessGrant_role_check"
  CHECK (role IN ('leadership','project_manager','scrum_master','portfolio_manager','contributor','pmo_admin','system_admin'));
