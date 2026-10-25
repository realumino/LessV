"""LessV-Agent: node-side reconciler for LessV.

WHAT: Package marker holding the agent and protocol versions.
WHY: A single place for version truth so enroll/heartbeat/report
stay consistent and the dashboard can spot stale nodes.
"""

__version__ = "0.2.0"

#: Protocol version spoken by this agent. Binding contract lives in
#: LessV-Cloud/docs/PROTOCOL.md (v2: cert endpoint, X-Lessv-Node header).
#: This repo never copies it.
PROTOCOL_VERSION = 2
