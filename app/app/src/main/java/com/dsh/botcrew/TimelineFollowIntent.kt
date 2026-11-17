package com.dsh.botcrew

internal data class TimelineFollowIntent(val followsLatest: Boolean = true) {
    fun onUserScrollSettled(atBottom: Boolean) = copy(followsLatest = atBottom)

    fun stopFollowing() = copy(followsLatest = false)

    fun shouldAutoScroll(isScrollInProgress: Boolean) = followsLatest && !isScrollInProgress
}

internal fun timelineIsAtBottom(
    lastItemIndex: Int,
    totalItemsCount: Int,
    viewportEndOffset: Int,
    lastItemEndOffset: Int,
): Boolean = lastItemIndex >= totalItemsCount - 1 &&
    (viewportEndOffset - lastItemEndOffset) in -48..48
