package com.dsh.botcrew

/** Identity captured when a send starts; async completions may only update state owned by this request. */
data class SendOwner(
    val sessionKey: String,
    val requestId: String,
    val text: String,
)

data class PendingSend(
    val requestId: String,
    val text: String,
)

data class SendNote(
    val requestId: String,
    val message: String,
)

object SendOwnership {
    fun shouldClearDraft(activeSessionKey: String, currentDraft: String, owner: SendOwner): Boolean =
        activeSessionKey == owner.sessionKey && currentDraft == owner.text

    fun shouldClearPending(pendingBySession: Map<String, PendingSend>, owner: SendOwner): Boolean =
        pendingBySession[owner.sessionKey]?.requestId == owner.requestId

    fun shouldClearNote(notesBySession: Map<String, SendNote>, owner: SendOwner): Boolean =
        notesBySession[owner.sessionKey]?.requestId == owner.requestId
}
