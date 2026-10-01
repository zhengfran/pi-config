# Subagent Collaboration

The vocabulary for named agent roles and their running conversations in the Pi subagents extension. It distinguishes a child’s identity and relationships from any particular coding harness or terminal pane.

## Identity

**Agent profile**:
A reusable role definition that describes an agent’s purpose and permitted capabilities; it is not a conversation or a running process.
_Avoid_: agent, worker (when referring to a role)

**Agent instance**:
One durable child conversation created from an agent profile or an ad hoc task. Its stable identity persists across runs, parent-session changes, and panel changes.
_Avoid_: pane, process, profile (when referring to a child)

**Delegation group**:
The enduring set of agent instances associated with one originating parent conversation. Display names identify instances only within this group; stable instance IDs identify them across groups.
_Avoid_: session (when referring to the group)

**Parent conversation**:
The Pi conversation that originally created a delegation group. Reopening it restores access to its group, while another conversation must explicitly attach.
_Avoid_: current Pi window

**Run**:
A period of model activity within an agent instance. One instance may have multiple runs while retaining the same conversation identity.
_Avoid_: instance (when referring to a single turn of work)

## Communication

**Message**:
An addressed communication between a parent and child or between permitted peers. Its identity and sender are distinct from the text it carries.
_Avoid_: prompt (when referring to the durable addressed item)

**Question**:
A message requesting an explicitly correlated reply. It remains pending even if the asking instance stops working or its parent conversation is closed.
_Avoid_: result

**Result**:
The recorded outcome of a run, associated with its instance and originating group. A result can remain uncollected after the parent conversation closes.
_Avoid_: message delivery receipt

**Message receipt**:
Evidence of a particular message’s progress. Acceptance for delivery, delivery to a native conversation, and acknowledgement by its recipient are different facts.
_Avoid_: success (without naming the observed stage)
