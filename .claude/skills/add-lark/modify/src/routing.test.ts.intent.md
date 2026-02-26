# Intent: src/routing.test.ts modifications

## What changed
Added Lark JID pattern tests and Lark-specific getAvailableGroups tests.

## Key sections
- **JID ownership patterns**: Added Lark group JID (`lark:oc_...`) and Lark chat JID (`lark:oc_...`) pattern tests
- **getAvailableGroups**: Added tests for Lark group inclusion, Lark p2p handling, registered Lark groups, and mixed WhatsApp + Lark ordering

## Invariants
- All existing WhatsApp JID pattern tests remain unchanged
- All existing getAvailableGroups tests remain unchanged
- New tests follow the same patterns as existing tests

## Must-keep
- All existing WhatsApp tests (group JID, DM JID patterns)
- All existing getAvailableGroups tests (DM exclusion, sentinel exclusion, registration, ordering, non-group exclusion, empty array)
