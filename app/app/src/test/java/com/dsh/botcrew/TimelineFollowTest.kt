package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Test

class TimelineFollowTest {
    @Test
    fun newMessagesFollowUntilUserSettlesInHistory() {
        var intent = TimelineFollowIntent()

        assertEquals(true, intent.shouldAutoScroll(isScrollInProgress = false)) // own message
        assertEquals(true, intent.shouldAutoScroll(isScrollInProgress = false)) // agent reply

        intent = intent.onUserScrollSettled(atBottom = false)
        assertEquals(false, intent.shouldAutoScroll(isScrollInProgress = false))

        intent = intent.onUserScrollSettled(atBottom = true)
        assertEquals(true, intent.shouldAutoScroll(isScrollInProgress = false))
    }

    @Test
    fun activeDragSuppressesScrollButKeepsFollowIntent() {
        val intent = TimelineFollowIntent()

        assertEquals(false, intent.shouldAutoScroll(isScrollInProgress = true))
        assertEquals(true, intent.shouldAutoScroll(isScrollInProgress = false))
    }

    @Test
    fun explicitHistoryNavigationStopsFollowing() {
        assertEquals(false, TimelineFollowIntent().stopFollowing().shouldAutoScroll(isScrollInProgress = false))
    }

    @Test
    fun eachNewSessionStartsFollowing() {
        assertEquals(true, TimelineFollowIntent().shouldAutoScroll(isScrollInProgress = false))
    }

    @Test
    fun tallLastItemEnding600PixelsPastViewportIsNotAtBottom() {
        assertEquals(
            false,
            timelineIsAtBottom(
                lastItemIndex = 4,
                totalItemsCount = 5,
                viewportEndOffset = 1_000,
                lastItemEndOffset = 1_600,
            ),
        )
    }

    @Test
    fun actualBottomPaddingGapOf38PixelsIsAtBottom() {
        assertEquals(
            true,
            timelineIsAtBottom(
                lastItemIndex = 4,
                totalItemsCount = 5,
                viewportEndOffset = 1_000,
                lastItemEndOffset = 962,
            ),
        )
    }
}
