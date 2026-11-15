#define OC_STATUS_ANIMATION_TEST
#include "../src/c/oc-status.c"

#include <assert.h>
#include <stdio.h>

static void test_spinner_transitions(void) {
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
  uint8_t flags[] = { 0, FLAG_RUNNING, 0, FLAG_RUNNING, 0, 0, FLAG_RUNNING };
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

int main(void) {
  test_spinner_transitions();
  test_visible_ranges_and_flags();
  test_marquee_cache_and_visibility();
  test_capability_values();
  puts("watch animation harness passed");
  return 0;
}
