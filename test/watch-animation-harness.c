#define OC_STATUS_ANIMATION_TEST
#include "../src/c/oc-status.c"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_spinner_transitions(void) {
  assert(session_shows_spinner(FLAG_SUBAGENTS_RUNNING));
  assert(!session_shows_spinner(FLAG_SUBAGENTS_RUNNING | FLAG_PERMISSION));
  assert(!session_shows_spinner(FLAG_SUBAGENTS_RUNNING | FLAG_QUESTION));
  assert(session_shows_spinner(FLAG_RUNNING));
  OcSpinnerState state = { true, OC_SURFACE_LIST, true, false };
  assert(oc_spinner_timer_action(&state, false) == OC_TIMER_START);
  assert(oc_spinner_timer_action(&state, true) == OC_TIMER_KEEP);
  assert(oc_spinner_should_run(&state));
  state.list_visible_spinner = false; // running row offscreen
  assert(oc_spinner_timer_action(&state, true) == OC_TIMER_CANCEL);
  assert(oc_spinner_timer_action(&state, false) == OC_TIMER_KEEP);
  assert(!oc_spinner_should_run(&state));
  state.list_visible_spinner = true;
  state.app_focused = false; // notification, dictation overlay, or system surface
  assert(!oc_spinner_should_run(&state));
  state.app_focused = true;
  state.surface = OC_SURFACE_DETAIL;
  state.list_visible_spinner = false;
  state.detail_spinner = true;
  assert(oc_spinner_should_run(&state));
  state.surface = OC_SURFACE_NONE; // canned window on top
  assert(!oc_spinner_should_run(&state));
  state.surface = OC_SURFACE_DETAIL;
  state.detail_spinner = false;
  assert(!oc_spinner_should_run(&state));
}

static void test_visible_ranges_and_flags(void) {
  uint8_t flags[] = { 0, FLAG_RUNNING, 0, FLAG_SUBAGENTS_RUNNING, 0, 0, FLAG_RUNNING };
  OcRowRange range;

  // Negative translation exposes rows below top; partially clipped boundary rows count.
  assert(oc_visible_row_range(7, 38, 80, -30, &range));
  assert(range.first == 0 && range.last == 2);
  assert(oc_visible_flags_have_spinner(flags, 7, 38, 80, -30));
  assert(oc_visible_row_range(7, 38, 80, -76, &range));
  assert(range.first == 2 && range.last == 4);
  assert(oc_visible_flags_have_spinner(flags, 7, 38, 80, -76));

  // Positive content translation moves row zero down; rows past viewport are not visible.
  assert(oc_visible_row_range(7, 38, 80, 10, &range));
  assert(range.first == 0 && range.last == 1);
  assert(oc_visible_flags_have_spinner(flags, 7, 38, 80, 10));
  assert(oc_visible_row_range(7, 38, 80, 76, &range));
  assert(range.first == 0 && range.last == 0);
  assert(!oc_visible_flags_have_spinner(flags, 7, 38, 80, 76));
  assert(!oc_visible_row_range(7, 38, 80, 80, &range));
  assert(!oc_visible_row_range(7, 38, 80, 200, &range));
  assert(!oc_visible_row_range(7, 38, 80, -266, &range)); // beyond final content row

  // Empty/invalid geometry must never expose a row.
  assert(!oc_visible_row_range(0, 38, 80, 0, &range));
  assert(!oc_visible_row_range(7, 0, 80, 0, &range));
  assert(!oc_visible_row_range(7, 38, 0, 0, &range));
}

static int measurement_count;

static void cached_measurement(OcMarqueeMetrics *metrics, uint32_t version,
                               int bounds, int text_width) {
  if (oc_marquee_metrics_match(metrics, version, bounds)) return;
  measurement_count++;
  oc_marquee_metrics_store(metrics, version, bounds, text_width, bounds - 48);
}

static void test_marquee_cache_and_visibility(void) {
  OcMarqueeMetrics metrics = {0};
  cached_measurement(&metrics, 1, 144, 250);
  cached_measurement(&metrics, 1, 144, 999); // 80ms tick reuses measured value
  assert(measurement_count == 1);
  assert(metrics.text_width == 250 && metrics.visible_width == 96);
  assert(oc_marquee_metrics_cached(&metrics, 1, 144) == &metrics);

  cached_measurement(&metrics, 2, 144, 300); // new description chunk/text version
  assert(measurement_count == 2 && metrics.text_width == 300);
  oc_marquee_metrics_clear(&metrics);
  assert(!metrics.valid);
  int before_cached_tick = measurement_count;
  assert(oc_marquee_metrics_cached(&metrics, 2, 144) == NULL);
  assert(measurement_count == before_cached_tick); // timer path must not measure on a cache miss
  cached_measurement(&metrics, 2, 180, 330); // bounds changed
  assert(measurement_count == 3 && metrics.bounds_width == 180);

  OcMarqueeVisibility visible = { true, true, true, true, true };
  assert(oc_marquee_should_run(&visible));
  visible.detail_on_top = false; // canned/system window covers detail
  assert(!oc_marquee_should_run(&visible));
  visible.detail_on_top = true;
  visible.app_focused = false;
  assert(!oc_marquee_should_run(&visible));
  assert(oc_marquee_next_offset(0, 250, 96) == MARQUEE_STEP_PX);
  assert(oc_marquee_next_offset(300, 250, 96) == 0);
  assert(oc_marquee_next_offset(10, 20, 96) == 0);
}

static void test_capability_values(void) {
#ifdef PBL_PLATFORM_APLITE
  assert(oc_reply_capacity() == 1855);
  assert(oc_inbox_capacity() == 512);
#else
  assert(oc_reply_capacity() == 4399);
  assert(oc_inbox_capacity() == 1024);
#endif
}

static void test_open_reply_startup_hello_and_retry_exhaustion(void) {
  assert(oc_open_reply_hello_action(false, true) == OC_OPEN_REPLY_HELLO_NORMAL);
  assert(oc_open_reply_hello_action(false, false) == OC_OPEN_REPLY_HELLO_NORMAL);
  assert(oc_open_reply_hello_action(true, false) == OC_OPEN_REPLY_HELLO_SKIP);
  assert(oc_open_reply_hello_action(true, true) == OC_OPEN_REPLY_HELLO_TOKEN_ONLY);
  assert(!oc_open_reply_retries_exhausted(0));
  assert(!oc_open_reply_retries_exhausted(OPEN_REPLY_MAX_ATTEMPTS - 1));
  assert(oc_open_reply_retries_exhausted(OPEN_REPLY_MAX_ATTEMPTS));
}

static void test_subagent_count_and_layout(void) {
  char text[4];
  assert(oc_clamp_subagent_count(-7) == 0);
  assert(oc_clamp_subagent_count(0) == 0);
  assert(oc_clamp_subagent_count(1) == 1);
  assert(oc_clamp_subagent_count(255) == 255);
  assert(oc_clamp_subagent_count(256) == 255);

  uint8_t reused_row_count = 3;
  reused_row_count = oc_subagent_count_value(0); // tuple_int fallback for absent key
  assert(reused_row_count == 0); // missing optional key resets reused row
  reused_row_count = oc_subagent_count_value(301);
  assert(reused_row_count == 255);

  oc_format_group_count(0, text);
  assert(text[0] == '\0');
  oc_format_group_count(1, text);
  assert(strcmp(text, "1") == 0);
  oc_format_group_count(23, text);
  assert(strcmp(text, "23") == 0);
  oc_format_group_count(255, text);
  assert(strcmp(text, "255") == 0);

  const int icon_x = 100;
  assert(oc_group_count_slot_width(0) == 0);
  assert(oc_group_count_x(0, icon_x) == icon_x);
  assert(oc_group_count_slot_width(1) == GROUP_COUNT_WIDTH + GROUP_COUNT_GAP);
  assert(oc_group_count_slot_width(3) == GROUP_COUNT_WIDTH + GROUP_COUNT_GAP);
  assert(oc_group_count_x(1, icon_x) + GROUP_COUNT_WIDTH + GROUP_COUNT_GAP == icon_x);
  assert(oc_group_count_x(3, icon_x) + GROUP_COUNT_WIDTH + GROUP_COUNT_GAP == icon_x);
}

int main(void) {
  test_spinner_transitions();
  test_visible_ranges_and_flags();
  test_marquee_cache_and_visibility();
  test_capability_values();
  test_open_reply_startup_hello_and_retry_exhaustion();
  test_subagent_count_and_layout();
  puts("watch animation harness passed");
  return 0;
}
