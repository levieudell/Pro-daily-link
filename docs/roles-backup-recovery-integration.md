# Roles integration of backup receipt recovery

This source-only successor combines the reviewed Roles head `4d429d83cd051167b6db3d57c2f96581e8e4e308` with deployed main `540c64e7d6106add80b99e9a3b4c88bef754ba33` (PR191). It preserves durable receipt metadata and startup recovery for ordinary unmanaged tenants. It does not install or activate any authority, change accounts, grants, policies, keys, configuration or production data.

## Receipt handling

The existing storage wrapper forwards the fifth upload argument. Replacement is allowed only for `tenant-backups/<current-company>/_receipt.json`, with JSON content type and a fresh unmanaged-tenant guard. Photo uploads and immutable backup objects retain `upsert=false`; their existing authority-effect descriptors are unchanged.

Restored metadata is limited to 64KiB, validated against the requested company, projected to known bounded fields and written with exclusive creation. A receipt created while the download is pending wins. Mirrors run in per-company order and the write/recovery paths await completion. Failed receipt mirroring does not turn a completed business write into a retryable business failure. These process-local queues are not a cross-worker storage CAS contract.

## Authority boundary

The fail-closed Roles startup sequence, request-time authority and shared managed-company fence remain in place. Startup self-heal and receipt operations reject configured Roles tenants, passively Roles-managed rows and platform-managed rows before reading legacy receipts, creating legacy backups or writing provider objects. The guard is refreshed before local receipt creation and upload admission.

Managed snapshots require a separately reviewed backup authority and recovery procedure. This integration does not create a new system-operation kind or run an initializer against a managed tenant. Before future cutover, every old writer must be fenced and in-flight legacy backup/provider operations drained; a guard check cannot atomically coordinate independent stores.

## Evidence and release limits

Generated fixture tests cover concurrent local creation, tenant/shape/time/hash/size rejection, permission changes during download/mirror, ordered awaited uploads, actual server wrapper forwarding and rejection, and passive Roles/platform startup exclusion. The upstream cloud receipt assertions remain intact. Linux CI runs both receipt programs and the original full Roles proof suites on the exact source head.

Public health `restore=verified` is the existing upload/download/SHA256 roundtrip evidence for one tenant JSON snapshot. It is not proof of restoring the live database, all tenant snapshots, referenced attachment bytes or a complete disaster-recovery drill. Durable metadata does not clear those production release gates.

The confirmed Render service follows `main` with automatic deployment on commits, so merging this draft would also deploy it. This draft must remain unmerged until the external database contracts, managed flags, configuration, writers and recoverable snapshot/object evidence are verified and a separate exact-action approval is obtained. Real permission changes additionally require their own current Owner preview/revision/reason/diff/affected-account confirmation.
