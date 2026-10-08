-- Empty consolidation groups can be removed. Posted journals stay immutable.
-- elimination_entry still references the group, so a group with eliminations cannot be deleted.
GRANT DELETE ON consolidation_group TO nexora_app;
