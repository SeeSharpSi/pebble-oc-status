// OC Status: a small Pebble dashboard for the OpenCode Pebble plugin.
//
// The watch never talks to OpenCode. PKJS owns the plugin subscriptions and sends this app a
// flat, ordered session list plus, on demand, one session's latest reply or current question.
// A braille-style dot cell spins beside work that is running; a solid dot marks anything that
// needs the user (a question, a permission request, or a finished reply they have not opened).

#include <pebble.h>

#define MAX_SESSIONS 20
#define SESSION_ID_LEN 64
#define SESSION_NAME_LEN 56
#define MAX_CHOICES 24
#define CHOICE_LABEL_LEN 56
#define QUESTION_ROW_HEIGHT 40
#define CHOICE_ROW_HEIGHT 40
#define MARQUEE_INTERVAL_MS 80
#define MARQUEE_STEP_PX 2
#define MARQUEE_GAP_PX 24
#define LIST_ROW_HEIGHT 38
#define HEADER_HEIGHT LIST_ROW_HEIGHT
#define HEADER_TOP PBL_IF_ROUND_ELSE(7, 0)
#define QUESTION_PROMPT_HEIGHT 30
#define SPINNER_BOX_HEIGHT 24
#define SPINNER_NUDGE 3
#define FOOTER_HEIGHT 18
#define DETAIL_BODY_Y HEADER_HEIGHT
#ifdef PBL_PLATFORM_APLITE
#define REPLIES_BUFFER_SIZE 1856
#define QUESTION_DESCRIPTION_LEN 384
#define CHOICE_DESCRIPTION_LEN 160
#else
#define REPLIES_BUFFER_SIZE 4400
#define QUESTION_DESCRIPTION_LEN 768
#define CHOICE_DESCRIPTION_LEN 240
#endif

#define FLAG_RUNNING 0x01
#define FLAG_ATTENTION 0x02
#define FLAG_QUESTION 0x04
#define FLAG_UNVIEWED 0x08
#define FLAG_SUBAGENT 0x10
#define FLAG_PERMISSION 0x20

#define DETAIL_REPLY 1
#define DETAIL_QUESTION 2
#define DETAIL_MESSAGE 3
#define DETAIL_PERMISSION 4
#define DETAIL_SEND 5
#define DETAIL_PERMISSION_DECISION 6
#define DETAIL_QUESTION_TEXT 7
#define DETAIL_ANSWER_TEXT 8
#define PROMPT_TEXT_MAX 1024
#define PROMPT_CHUNK_BYTES 100

typedef struct {
  char id[SESSION_ID_LEN];
  char name[SESSION_NAME_LEN];
  uint8_t flags;
} Session;

typedef struct {
  char label[CHOICE_LABEL_LEN];
  bool selected;
  bool done;
} Choice;

static Window *s_list_window;
static MenuLayer *s_list_menu;
static Layer *s_footer_layer;
static Session s_sessions[MAX_SESSIONS];
static Session s_incoming[MAX_SESSIONS];
static int s_session_count;
static int s_incoming_count;
static bool s_list_loading = true;
static bool s_have_list;
static char s_status_text[48] = "Connecting...";
static bool s_has_spinner;
static int s_spin_frame;
static AppTimer *s_spin_timer;
static AppTimer *s_connect_timer;
static GFont s_braille_font;

static Window *s_detail_window;
static Layer *s_header_bg;
static TextLayer *s_detail_header;
static Layer *s_detail_status_layer;
static Layer *s_header_rule;
static ScrollLayer *s_detail_scroll;
static TextLayer *s_detail_text;
static TextLayer *s_question_prompt;
static MenuLayer *s_choice_menu;
static char s_detail_header_text[192];
static char s_detail_session[SESSION_ID_LEN];
static char s_detail_name[SESSION_NAME_LEN];
static char s_detail_message_id[96];
static char s_permission_request_id[128];
static uint8_t s_detail_flags;
static bool s_detail_open;
static bool s_detail_header_single;
static bool s_answer_pending;
static int s_detail_mode = DETAIL_REPLY;
static Choice s_choices[MAX_CHOICES];
static int s_choice_count;
static int s_question_expected;
static bool s_question_multi;
static char s_question_title[128];
static char s_question_field[128];
static char s_question_notice[64];
static char s_question_prompt_text[192];
#ifndef PBL_PLATFORM_APLITE
static char s_question_description[QUESTION_DESCRIPTION_LEN];
static int s_question_description_len;
static int s_question_description_expected;
static int s_question_description_next;
static char s_choice_description[CHOICE_DESCRIPTION_LEN];
static char s_choice_full_label[128];
static int s_answer_detail_choice = -1;
static bool s_choice_description_loading;
static TextLayer *s_answer_label_text;
static TextLayer *s_answer_description_text;
static AppTimer *s_marquee_timer;
static int s_marquee_offset;
#endif
static char s_reply_buffer[REPLIES_BUFFER_SIZE];
static size_t s_reply_len;
static int s_reply_expected;
static int s_reply_next;
static AppTimer *s_result_timer;

#ifndef PBL_PLATFORM_APLITE
static DictationSession *s_dictation;
static char s_prompt_text[PROMPT_TEXT_MAX];
static size_t s_prompt_len;
static size_t s_prompt_offset;
static int s_prompt_chunks;
static int s_prompt_next;
static int s_prompt_phase;
static uint8_t s_prompt_delivery;
#endif
static bool s_prompt_uploading;
static bool s_send_pending;

static void spinner_tick(void *data);
static void list_recalc_spinner(void);
static void detail_error(const char *text);
#ifndef PBL_PLATFORM_APLITE
static void detail_show_send_mode(void);
static void start_prompt_upload(void);
static void send_next_prompt_message(void);
#endif
static void detail_select_click(ClickRecognizerRef recognizer, void *context);
static void detail_scroll_click_config(void *context);
#ifndef PBL_PLATFORM_APLITE
static void question_marquee_start(void);
static void question_marquee_stop(void);
#endif

static const uint8_t BRAILLE_FRAMES[] = {
  0x0b, 0x19, 0x39, 0x38, 0x3c, 0x34, 0x26, 0x27, 0x07, 0x0f,
};

// The exact ten frames OpenCode's CLI spinner uses: braille U+280B, U+2819, U+2839, U+2838,
// U+283C, U+2834, U+2826, U+2827, U+2807, and U+280F.
static const char *const SPINNER_GLYPHS[] = {
  "\xe2\xa0\x8b", "\xe2\xa0\x99", "\xe2\xa0\xb9", "\xe2\xa0\xb8", "\xe2\xa0\xbc",
  "\xe2\xa0\xb4", "\xe2\xa0\xa6", "\xe2\xa0\xa7", "\xe2\xa0\x87", "\xe2\xa0\x8f",
};

static GColor list_highlight(void) {
  return PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack);
}

static GColor list_highlight_text(void) {
  return GColorWhite;
}

static GColor muted_text(void) {
  return PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack);
}

static GColor line_color(void) {
  return PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack);
}

static GColor attention_color(void) {
  return PBL_IF_COLOR_ELSE(GColorOrange, GColorBlack);
}

static GColor reason_dot_color(uint8_t flags, bool highlighted) {
#ifdef PBL_COLOR
  if (flags & FLAG_PERMISSION) return GColorRed;
  if (flags & FLAG_QUESTION) return GColorYellow;
  if (flags & FLAG_UNVIEWED) return GColorIslamicGreen;
  return attention_color();
#else
  return highlighted ? GColorWhite : attention_color();
#endif
}

static bool session_shows_spinner(uint8_t flags) {
  return (flags & FLAG_RUNNING) && !(flags & (FLAG_PERMISSION | FLAG_QUESTION));
}

static void draw_reason_dot(GContext *ctx, GPoint center, uint8_t flags, bool highlighted) {
  graphics_context_set_fill_color(ctx, reason_dot_color(flags, highlighted));
  graphics_fill_circle(ctx, center, 3);
#ifdef PBL_COLOR
  if ((flags & FLAG_QUESTION) && !(flags & FLAG_PERMISSION)) {
    graphics_context_set_stroke_color(ctx, GColorBlack);
    graphics_draw_circle(ctx, center, 4);
  }
#endif
}
static void copy_clean(char *dst, size_t cap, const char *src, bool one_line) {
  if (!dst || cap == 0) return;
  dst[0] = '\0';
  if (!src) return;
  size_t out = 0;
  bool space = false;
  for (const char *p = src; *p && out + 1 < cap; p++) {
    unsigned char c = (unsigned char)*p;
    if (one_line && (c == '\n' || c == '\r' || c == '\t')) c = ' ';
    if (c < 0x20 && c != '\n' && c != '\t') continue;
    if (one_line && c == ' ') {
      if (out == 0 || space) continue;
      space = true;
    } else {
      space = false;
    }
    dst[out++] = (char)c;
  }
  while (out > 0 && dst[out - 1] == ' ') out--;
  // The source is UTF-8; do not leave a partial sequence when the destination is too small.
  if (out > 0) {
    size_t start = out - 1;
    while (start > 0 && ((unsigned char)dst[start] & 0xc0) == 0x80) start--;
    unsigned char lead = (unsigned char)dst[start];
    size_t need = (lead & 0x80) == 0 ? 1 :
                  (lead & 0xe0) == 0xc0 ? 2 :
                  (lead & 0xf0) == 0xe0 ? 3 :
                  (lead & 0xf8) == 0xf0 ? 4 : 1;
    if (out - start < need) out = start;
  }
  dst[out] = '\0';
}

static int tuple_int(DictionaryIterator *iter, uint32_t key, int fallback) {
  Tuple *t = dict_find(iter, key);
  if (!t) return fallback;
  if (t->type == TUPLE_INT) return (int)t->value->int32;
  if (t->type == TUPLE_UINT) return (int)t->value->uint32;
  if (t->type == TUPLE_CSTRING) return atoi(t->value->cstring);
  return fallback;
}

static const char *tuple_string(DictionaryIterator *iter, uint32_t key, const char *fallback) {
  Tuple *t = dict_find(iter, key);
  if (!t || t->type != TUPLE_CSTRING || t->length == 0) return fallback;
  return t->value->cstring;
}

static bool tuple_present(DictionaryIterator *iter, uint32_t key) {
  return dict_find(iter, key) != NULL;
}

static bool detail_matches(DictionaryIterator *iter) {
  const char *session = tuple_string(iter, MESSAGE_KEY_session_id, NULL);
  return !session || strcmp(session, s_detail_session) == 0;
}

// ---------------------------------------------------------------- braille spinner

static void braille_dot(GContext *ctx, GPoint origin, int dot, int radius) {
  static const int8_t dx[2] = {2, 8};
  static const int8_t dy[3] = {2, 7, 12};
  graphics_fill_circle(ctx, GPoint(origin.x + dx[dot % 2], origin.y + dy[dot / 2]), radius);
}

static void draw_braille(GContext *ctx, GPoint origin, uint8_t bits) {
  for (int dot = 0; dot < 6; dot++) {
    if (!(bits & (1 << dot))) continue;
    braille_dot(ctx, origin, dot, 2);
  }
}

static void draw_spinner(GContext *ctx, GRect frame, GColor color, int frame_index) {
  int index = frame_index % (int)ARRAY_LENGTH(SPINNER_GLYPHS);
  if (s_braille_font) {
    graphics_context_set_text_color(ctx, color);
    graphics_draw_text(ctx, SPINNER_GLYPHS[index], s_braille_font, frame,
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    return;
  }
  GPoint origin = GPoint(frame.origin.x + (frame.size.w - 11) / 2,
                         frame.origin.y + (frame.size.h - 14) / 2);
  graphics_context_set_fill_color(ctx, color);
  draw_braille(ctx, origin, BRAILLE_FRAMES[index]);
}

// ---------------------------------------------------------------- session list

static uint16_t list_get_num_sections(MenuLayer *menu_layer, void *data) {
  return 1;
}

static uint16_t list_get_num_rows(MenuLayer *menu_layer, uint16_t section_index, void *data) {
  return s_session_count > 0 ? (uint16_t)s_session_count : 1;
}

static int16_t list_get_cell_height(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  return LIST_ROW_HEIGHT;
}

static void list_draw_empty(GContext *ctx, const Layer *cell_layer) {
  GRect bounds = layer_get_bounds(cell_layer);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorBlack);
  bool no_action = !s_list_loading && strcmp(s_status_text, "No action") == 0;
  const char *title = s_list_loading ? "Connecting..." : (no_action ? "No action" : "No sessions");
  const char *subtitle = s_list_loading ? "Waiting for phone" :
                         (no_action ? "All caught up" : "Start a session");
  graphics_draw_text(ctx, title,
                     fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(8, 3, bounds.size.w - 16, 22),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  graphics_context_set_text_color(ctx, muted_text());
  graphics_draw_text(ctx, subtitle,
                     fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(8, 22, bounds.size.w - 16, 16),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void list_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *data) {
  GRect bounds = layer_get_bounds(cell_layer);
  if (s_session_count == 0) {
    list_draw_empty(ctx, cell_layer);
    return;
  }
  if (cell_index->row >= (uint16_t)s_session_count) return;

  Session *session = &s_sessions[cell_index->row];
  bool highlighted = menu_cell_layer_is_highlighted(cell_layer);
  GColor background = highlighted ? list_highlight() : GColorWhite;
  GColor foreground = highlighted ? list_highlight_text() : GColorBlack;

  graphics_context_set_fill_color(ctx, background);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  // Status lives on the right: names get the full width when there is nothing to show.
  bool has_status = (session->flags & (FLAG_ATTENTION | FLAG_UNVIEWED | FLAG_RUNNING)) != 0;
  int name_x = PBL_IF_ROUND_ELSE(32, 6);
  int status_width = 20;
  int status_right = PBL_IF_ROUND_ELSE(38, 8);
  GRect status_rect = GRect(bounds.size.w - status_right - status_width, 0,
                            status_width, bounds.size.h);
  int right_inset = has_status ? (bounds.size.w - status_rect.origin.x + 4) :
                                 PBL_IF_ROUND_ELSE(28, 6);

  // A running session shows motion even when it has an unread completion; permission and
  // question dots still take priority because those need an answer.
  if (session->flags & (FLAG_PERMISSION | FLAG_QUESTION)) {
    draw_reason_dot(ctx,
                    GPoint(status_rect.origin.x + status_rect.size.w / 2, bounds.size.h / 2),
                    session->flags, highlighted);
  } else if (session->flags & FLAG_RUNNING) {
    GRect spinner_rect = GRect(status_rect.origin.x,
                               (bounds.size.h - SPINNER_BOX_HEIGHT) / 2 + SPINNER_NUDGE,
                               status_rect.size.w, SPINNER_BOX_HEIGHT);
    draw_spinner(ctx, spinner_rect, highlighted ? foreground : muted_text(), s_spin_frame);
  } else if (session->flags & (FLAG_ATTENTION | FLAG_UNVIEWED)) {
    draw_reason_dot(ctx,
                    GPoint(status_rect.origin.x + status_rect.size.w / 2, bounds.size.h / 2),
                    session->flags, highlighted);
  }

  graphics_context_set_text_color(ctx, foreground);
  graphics_draw_text(ctx, session->name,
                     fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                     GRect(name_x, 3, bounds.size.w - name_x - right_inset, 32),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

  if (!highlighted) {
    graphics_context_set_stroke_color(ctx, line_color());
    graphics_draw_line(ctx, GPoint(0, bounds.size.h - 1),
                       GPoint(bounds.size.w, bounds.size.h - 1));
  }
}

static void request_detail(const char *session_id, const char *name, uint8_t flags);

static void request_list_refresh(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    dict_write_uint8(out, MESSAGE_KEY_req, 1);
    app_message_outbox_send();
  }
}

static void request_clear_completed(const char *session_id) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_uint8(out, MESSAGE_KEY_clear_completed, 1);
  dict_write_cstring(out, MESSAGE_KEY_session_id, session_id);
  app_message_outbox_send();
}

static void list_select(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  if (s_session_count == 0) {
    request_list_refresh();
    return;
  }
  if (cell_index->row >= (uint16_t)s_session_count) return;
  Session *session = &s_sessions[cell_index->row];
  request_detail(session->id, session->name, session->flags);
}

static void list_select_long(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  if (s_session_count == 0 || cell_index->row >= (uint16_t)s_session_count) {
    request_list_refresh();
    return;
  }
  Session *session = &s_sessions[cell_index->row];
  // The green completion dot is the one status the list can clear without opening the session.
  // Permission and question dots stay put; they need the detail screen.
  bool completed = (session->flags & FLAG_UNVIEWED) &&
                   !(session->flags & (FLAG_PERMISSION | FLAG_QUESTION));
  if (!completed) {
    request_list_refresh();
    return;
  }

  request_clear_completed(session->id);
  session->flags &= (uint8_t)~(FLAG_UNVIEWED | FLAG_ATTENTION);
  list_recalc_spinner();
  copy_clean(s_status_text, sizeof(s_status_text), "Clearing...", true);
  if (s_list_menu) menu_layer_reload_data(s_list_menu);
  if (s_footer_layer) layer_mark_dirty(s_footer_layer);
}

static void footer_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_stroke_color(ctx, line_color());
  graphics_draw_line(ctx, GPoint(0, 0), GPoint(bounds.size.w, 0));
  graphics_context_set_text_color(ctx, muted_text());
  graphics_draw_text(ctx, s_status_text, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(4, 1, bounds.size.w - 8, 16),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void list_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  s_list_menu = menu_layer_create(GRect(0, 0, bounds.size.w, bounds.size.h - FOOTER_HEIGHT));
  menu_layer_set_callbacks(s_list_menu, NULL, (MenuLayerCallbacks){
    .get_num_sections = list_get_num_sections,
    .get_num_rows = list_get_num_rows,
    .get_cell_height = list_get_cell_height,
    .draw_row = list_draw_row,
    .select_click = list_select,
    .select_long_click = list_select_long,
  });
  menu_layer_set_normal_colors(s_list_menu, GColorWhite, GColorBlack);
  menu_layer_set_highlight_colors(s_list_menu, list_highlight(), list_highlight_text());
  menu_layer_set_click_config_onto_window(s_list_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_list_menu));

  s_footer_layer = layer_create(GRect(0, bounds.size.h - FOOTER_HEIGHT, bounds.size.w, FOOTER_HEIGHT));
  layer_set_update_proc(s_footer_layer, footer_update);
  layer_add_child(root, s_footer_layer);
}

static void list_window_unload(Window *window) {
  menu_layer_destroy(s_list_menu);
  s_list_menu = NULL;
  layer_destroy(s_footer_layer);
  s_footer_layer = NULL;
}

// ---------------------------------------------------------------- detail header

static void header_rule_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, line_color());
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
}

static void header_bg_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
}

static void layout_detail_header(void);

static void set_detail_header(const char *title, const char *subtitle) {
  if (!s_detail_header) return;
  char clean_title[96];
  char clean_sub[64];
  copy_clean(clean_title, sizeof(clean_title), title ? title : "", true);
  copy_clean(clean_sub, sizeof(clean_sub), subtitle ? subtitle : "", true);
  if (clean_sub[0]) {
    snprintf(s_detail_header_text, sizeof(s_detail_header_text), "%s\n%s", clean_title, clean_sub);
    s_detail_header_single = false;
    text_layer_set_overflow_mode(s_detail_header, GTextOverflowModeWordWrap);
  } else {
    snprintf(s_detail_header_text, sizeof(s_detail_header_text), "%s", clean_title);
    s_detail_header_single = true;
    text_layer_set_overflow_mode(s_detail_header, GTextOverflowModeTrailingEllipsis);
  }
  text_layer_set_text(s_detail_header, s_detail_header_text);
  layout_detail_header();
}

static bool detail_status_visible(void) {
  return (s_detail_flags & (FLAG_ATTENTION | FLAG_UNVIEWED | FLAG_RUNNING)) != 0;
}

static bool detail_spinner_active(void) {
  return s_detail_open && session_shows_spinner(s_detail_flags);
}

static void detail_status_update(Layer *layer, GContext *ctx) {
  if (!detail_status_visible()) return;
  GRect bounds = layer_get_bounds(layer);
  if (s_detail_flags & (FLAG_PERMISSION | FLAG_QUESTION)) {
    draw_reason_dot(ctx, GPoint(bounds.size.w / 2, bounds.size.h / 2),
                    s_detail_flags, false);
    return;
  }
  if (s_detail_flags & FLAG_RUNNING) {
    GRect spinner_rect = GRect(0,
                               (bounds.size.h - SPINNER_BOX_HEIGHT) / 2 + SPINNER_NUDGE,
                               bounds.size.w, SPINNER_BOX_HEIGHT);
    draw_spinner(ctx, spinner_rect, GColorBlack, s_spin_frame);
    return;
  }
  draw_reason_dot(ctx, GPoint(bounds.size.w / 2, bounds.size.h / 2),
                  s_detail_flags, false);
}

static void layout_detail_header(void) {
  if (!s_detail_header || !s_detail_status_layer) return;
  Layer *root = window_get_root_layer(s_detail_window);
  GRect bounds = layer_get_bounds(root);
  int pad = PBL_IF_ROUND_ELSE(34, 4);
  int status_width = 26;
  int status_right = PBL_IF_ROUND_ELSE(34, 6);
  bool has_status = detail_status_visible();
  int text_width = bounds.size.w - pad * 2 - (has_status ? status_width + 4 : 0);
  int text_y = s_detail_header_single ? (HEADER_HEIGHT - 26) / 2 : HEADER_TOP;
  int text_height = s_detail_header_single ? 26 : HEADER_HEIGHT - HEADER_TOP;
  layer_set_frame(text_layer_get_layer(s_detail_header),
                  GRect(pad, text_y, text_width, text_height));
  layer_set_frame(s_detail_status_layer,
                  GRect(bounds.size.w - status_right - status_width, 0, status_width, HEADER_HEIGHT));
  layer_set_hidden(s_detail_status_layer, !has_status);
  layer_mark_dirty(s_detail_status_layer);
}

// ---------------------------------------------------------------- question marquee

#ifndef PBL_PLATFORM_APLITE
static int question_text_x(void) {
  return PBL_IF_ROUND_ELSE(40, 10);
}

static int question_text_width(void) {
  Layer *root = window_get_root_layer(s_detail_window);
  return layer_get_bounds(root).size.w - question_text_x() - 8;
}

static GSize text_size(const char *text, GFont font, int width, bool wrap) {
  return graphics_text_layout_get_content_size(
      text && text[0] ? text : " ",
      font,
      GRect(0, 0, width, 1000),
      wrap ? GTextOverflowModeWordWrap : GTextOverflowModeTrailingEllipsis,
      GTextAlignmentLeft);
}

static const char *question_row_text(void) {
  if (s_question_description[0]) return s_question_description;
  if (s_question_description_expected > 0) return "Loading question...";
  if (s_question_field[0]) return s_question_field;
  return s_question_title[0] ? s_question_title : "Question";
}

static void question_marquee_tick(void *data) {
  s_marquee_timer = NULL;
  if (!s_detail_open || !s_choice_menu || s_detail_mode != DETAIL_QUESTION) {
    s_marquee_offset = 0;
    return;
  }
  MenuIndex selected = menu_layer_get_selected_index(s_choice_menu);
  if (selected.row != 0) {
    s_marquee_offset = 0;
    return;
  }
  int width = text_size(question_row_text(), fonts_get_system_font(FONT_KEY_GOTHIC_18),
                        8192, false).w;
  int visible = question_text_width();
  if (width <= visible) {
    s_marquee_offset = 0;
    return;
  }
  s_marquee_offset += MARQUEE_STEP_PX;
  if (s_marquee_offset > width - visible + MARQUEE_GAP_PX) s_marquee_offset = 0;
  layer_mark_dirty(menu_layer_get_layer(s_choice_menu));
  s_marquee_timer = app_timer_register(MARQUEE_INTERVAL_MS, question_marquee_tick, NULL);
}

static void question_marquee_stop(void) {
  if (s_marquee_timer) {
    app_timer_cancel(s_marquee_timer);
    s_marquee_timer = NULL;
  }
  s_marquee_offset = 0;
}

static void question_marquee_start(void) {
  question_marquee_stop();
  if (!s_detail_open || !s_choice_menu || s_detail_mode != DETAIL_QUESTION) return;
  MenuIndex selected = menu_layer_get_selected_index(s_choice_menu);
  if (selected.row != 0) return;
  int width = text_size(question_row_text(), fonts_get_system_font(FONT_KEY_GOTHIC_18),
                        8192, false).w;
  if (width <= question_text_width()) return;
  s_marquee_timer = app_timer_register(MARQUEE_INTERVAL_MS, question_marquee_tick, NULL);
}
#endif

// ---------------------------------------------------------------- detail: reply

static void show_reply_text(const char *text) {
  if (!s_detail_text || !s_detail_scroll) return;
  layer_set_hidden(text_layer_get_layer(s_detail_text), false);
  if (s_detail_window) {
    Layer *root = window_get_root_layer(s_detail_window);
    GRect bounds = layer_get_bounds(root);
    int body_pad = PBL_IF_ROUND_ELSE(22, 4);
    layer_set_frame(text_layer_get_layer(s_detail_text),
                    GRect(body_pad, 4, bounds.size.w - body_pad * 2, 5000));
  }
  text_layer_set_text(s_detail_text, text && text[0] ? text : "Nothing to show.");
  GRect frame = layer_get_frame(scroll_layer_get_layer(s_detail_scroll));
  GSize content = text_layer_get_content_size(s_detail_text);
  if (content.h < frame.size.h) content.h = frame.size.h;
  scroll_layer_set_content_size(s_detail_scroll, GSize(frame.size.w, content.h + 10));
  scroll_layer_set_content_offset(s_detail_scroll, GPoint(0, 0), false);
}

static void show_incoming_text(const char *text) {
  if (!text || !text[0]) {
    show_reply_text("Nothing to show.");
    return;
  }
  if (text >= s_reply_buffer && text < s_reply_buffer + sizeof(s_reply_buffer)) {
    show_reply_text(text);
    return;
  }
  copy_clean(s_reply_buffer, sizeof(s_reply_buffer), text, false);
  s_reply_len = strlen(s_reply_buffer);
  show_reply_text(s_reply_buffer);
}

#ifndef PBL_PLATFORM_APLITE
static void detail_hide_answer_layers(void) {
  if (s_answer_label_text) layer_set_hidden(text_layer_get_layer(s_answer_label_text), true);
  if (s_answer_description_text) layer_set_hidden(text_layer_get_layer(s_answer_description_text), true);
}
#endif

static void detail_scroll_frame(bool below_prompt) {
  if (!s_detail_window || !s_detail_scroll) return;
  Layer *root = window_get_root_layer(s_detail_window);
  GRect bounds = layer_get_bounds(root);
  int top = DETAIL_BODY_Y + (below_prompt ? QUESTION_PROMPT_HEIGHT : 0);
  scroll_layer_set_frame(s_detail_scroll,
                         GRect(0, top, bounds.size.w, bounds.size.h - top));
}

static void detail_show_reply_mode(void) {
#ifndef PBL_PLATFORM_APLITE
  question_marquee_stop();
  s_answer_detail_choice = -1;
  s_choice_description[0] = '\0';
  s_choice_full_label[0] = '\0';
  s_choice_description_loading = false;
  detail_hide_answer_layers();
#endif
  s_detail_mode = DETAIL_REPLY;
  detail_scroll_frame(false);
  layer_set_hidden(text_layer_get_layer(s_detail_header), false);
  layer_set_hidden(text_layer_get_layer(s_question_prompt), true);
  layer_set_hidden(scroll_layer_get_layer(s_detail_scroll), false);
  layer_set_hidden(menu_layer_get_layer(s_choice_menu), true);
  scroll_layer_set_click_config_onto_window(s_detail_scroll, s_detail_window);
}

static void detail_show_question_mode(void) {
  s_detail_mode = DETAIL_QUESTION;
  layer_set_hidden(text_layer_get_layer(s_detail_header), false);
  layer_set_hidden(text_layer_get_layer(s_question_prompt), false);
  layer_set_hidden(scroll_layer_get_layer(s_detail_scroll), true);
  layer_set_hidden(menu_layer_get_layer(s_choice_menu), false);
  menu_layer_set_click_config_onto_window(s_choice_menu, s_detail_window);
  if (s_choice_menu) menu_layer_reload_data(s_choice_menu);
#ifndef PBL_PLATFORM_APLITE
  detail_hide_answer_layers();
  s_answer_detail_choice = -1;
  question_marquee_start();
#endif
}

#ifndef PBL_PLATFORM_APLITE
static void detail_show_question_text_mode(void) {
  s_detail_mode = DETAIL_QUESTION_TEXT;
  question_marquee_stop();
  detail_hide_answer_layers();
  s_answer_detail_choice = -1;
  s_choice_description[0] = '\0';
  s_choice_full_label[0] = '\0';
  s_choice_description_loading = false;
  set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
  layer_set_hidden(text_layer_get_layer(s_detail_header), false);
  layer_set_hidden(text_layer_get_layer(s_question_prompt), false);
  layer_set_hidden(menu_layer_get_layer(s_choice_menu), true);
  detail_scroll_frame(true);
  layer_set_hidden(scroll_layer_get_layer(s_detail_scroll), false);
  scroll_layer_set_click_config_onto_window(s_detail_scroll, s_detail_window);
  show_reply_text(question_row_text());
}
#endif

static void detail_error(const char *text) {
  s_send_pending = false;
  s_prompt_uploading = false;
  if (!s_detail_open) return;
  detail_show_reply_mode();
  set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
  show_reply_text(text);
}

#ifndef PBL_PLATFORM_APLITE
static void detail_show_send_mode(void) {
  s_detail_mode = DETAIL_SEND;
  question_marquee_stop();
  detail_hide_answer_layers();
  s_answer_detail_choice = -1;
  s_answer_pending = false;
  s_question_multi = false;
  s_choice_count = 2;
  copy_clean(s_choices[0].label, sizeof(s_choices[0].label), "Queue after run", true);
  copy_clean(s_choices[1].label, sizeof(s_choices[1].label), "Steer active run", true);
  s_choices[0].selected = false;
  s_choices[1].selected = false;
  s_choices[0].done = false;
  s_choices[1].done = false;
  text_layer_set_text(s_question_prompt, "Send reply");
  set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
  layer_set_hidden(text_layer_get_layer(s_detail_header), false);
  layer_set_hidden(text_layer_get_layer(s_question_prompt), false);
  layer_set_hidden(scroll_layer_get_layer(s_detail_scroll), true);
  layer_set_hidden(menu_layer_get_layer(s_choice_menu), false);
  menu_layer_set_click_config_onto_window(s_choice_menu, s_detail_window);
  if (s_choice_menu) menu_layer_reload_data(s_choice_menu);
}
#endif

static void detail_show_permission_mode(void) {
  s_detail_mode = DETAIL_PERMISSION;
  s_answer_pending = false;
  detail_scroll_frame(false);
#ifndef PBL_PLATFORM_APLITE
  detail_hide_answer_layers();
#endif
  set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
  layer_set_hidden(text_layer_get_layer(s_detail_header), false);
  layer_set_hidden(text_layer_get_layer(s_question_prompt), true);
  layer_set_hidden(scroll_layer_get_layer(s_detail_scroll), false);
  layer_set_hidden(menu_layer_get_layer(s_choice_menu), true);
  scroll_layer_set_click_config_onto_window(s_detail_scroll, s_detail_window);
}

static void detail_show_permission_decision(void) {
  s_detail_mode = DETAIL_PERMISSION_DECISION;
#ifndef PBL_PLATFORM_APLITE
  question_marquee_stop();
  detail_hide_answer_layers();
  s_answer_detail_choice = -1;
#endif
  s_answer_pending = false;
  s_question_multi = false;
  s_choice_count = 2;
  copy_clean(s_choices[0].label, sizeof(s_choices[0].label), "Reject", true);
  copy_clean(s_choices[1].label, sizeof(s_choices[1].label), "Approve once", true);
  s_choices[0].selected = false;
  s_choices[1].selected = false;
  s_choices[0].done = false;
  s_choices[1].done = false;
  text_layer_set_text(s_question_prompt, "Approve permission?");
  set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
  layer_set_hidden(text_layer_get_layer(s_detail_header), false);
  layer_set_hidden(text_layer_get_layer(s_question_prompt), false);
  layer_set_hidden(scroll_layer_get_layer(s_detail_scroll), true);
  layer_set_hidden(menu_layer_get_layer(s_choice_menu), false);
  menu_layer_set_click_config_onto_window(s_choice_menu, s_detail_window);
  if (s_choice_menu) menu_layer_reload_data(s_choice_menu);
}

#ifndef PBL_PLATFORM_APLITE
static void detail_question_back_click(ClickRecognizerRef recognizer, void *context) {
  if (s_detail_mode == DETAIL_QUESTION_TEXT || s_detail_mode == DETAIL_ANSWER_TEXT) {
    detail_show_question_mode();
  }
}
#endif

static void detail_scroll_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, detail_select_click);
#ifndef PBL_PLATFORM_APLITE
  if (s_detail_mode == DETAIL_QUESTION_TEXT || s_detail_mode == DETAIL_ANSWER_TEXT) {
    window_single_click_subscribe(BUTTON_ID_BACK, detail_question_back_click);
  }
#endif
}

static void detail_select_click(ClickRecognizerRef recognizer, void *context) {
  if (s_answer_pending || s_send_pending || s_prompt_uploading) return;
#ifndef PBL_PLATFORM_APLITE
  if (s_detail_mode == DETAIL_QUESTION_TEXT || s_detail_mode == DETAIL_ANSWER_TEXT) {
    detail_show_question_mode();
    return;
  }
#endif
  if (s_detail_mode == DETAIL_PERMISSION) {
    detail_show_permission_decision();
    return;
  }
  if (s_detail_mode != DETAIL_REPLY) return;
#ifdef PBL_PLATFORM_APLITE
  detail_error("Dictation is not available on this watch.");
#else
  if (!s_dictation) {
    detail_error("Dictation is not available on this watch.");
    return;
  }
  DictationSessionStatus status = dictation_session_start(s_dictation);
  if (status != DictationSessionStatusSuccess) {
    detail_error("Could not start dictation. Check the phone connection.");
  }
#endif
}

// ---------------------------------------------------------------- detail: question

#ifndef PBL_PLATFORM_APLITE
static bool choices_question_mode(void) {
  return s_detail_mode == DETAIL_QUESTION;
}

static int choices_base_row(void) {
  return choices_question_mode() ? 1 : 0;
}

static int choice_text_x(bool multi) {
  if (!multi) return PBL_IF_ROUND_ELSE(48, 10);
  return PBL_IF_ROUND_ELSE(44, 9) + 23;
}

static GColor choice_subtext_color(bool highlighted) {
#ifdef PBL_COLOR
  return highlighted ? GColorLightGray : GColorDarkGray;
#else
  return highlighted ? GColorWhite : GColorBlack;
#endif
}

static uint16_t choices_get_num_sections(MenuLayer *menu_layer, void *data) {
  return 1;
}

static uint16_t choices_get_num_rows(MenuLayer *menu_layer, uint16_t section_index, void *data) {
  int rows = s_choice_count + choices_base_row();
  return rows > 0 ? (uint16_t)rows : 1;
}

static int16_t choices_get_cell_height(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  return choices_question_mode() && cell_index->row == 0 ? QUESTION_ROW_HEIGHT : CHOICE_ROW_HEIGHT;
}

static void draw_question_row(GContext *ctx, const Layer *cell_layer, GRect bounds, bool highlighted) {
  GColor fg = highlighted ? list_highlight_text() : GColorBlack;
  graphics_context_set_text_color(ctx, fg);
  int x = question_text_x();
  int width = bounds.size.w - x - 8;
  int offset = highlighted ? s_marquee_offset : 0;
  graphics_draw_text(ctx, question_row_text(),
                     fonts_get_system_font(FONT_KEY_GOTHIC_18),
                     GRect(x - offset, 7, width + offset, 26),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  // Hide the part of the scrolling line that would spill into the left margin.
  graphics_context_set_fill_color(ctx, highlighted ? list_highlight() : GColorWhite);
  graphics_fill_rect(ctx, GRect(0, 0, x, bounds.size.h), 0, GCornerNone);
}

static void draw_choice_row(GContext *ctx, const Layer *cell_layer, GRect bounds, int index,
                            bool highlighted) {
  GColor fg = highlighted ? list_highlight_text() : GColorBlack;
  int text_x = choice_text_x(s_question_multi);
  if (s_question_multi) {
    int box_x = PBL_IF_ROUND_ELSE(44, 9);
    if (!s_choices[index].done) {
      GRect box = GRect(box_x, 12, 14, 14);
      graphics_context_set_stroke_color(ctx, fg);
      graphics_draw_rect(ctx, box);
      if (s_choices[index].selected) {
        graphics_context_set_fill_color(ctx, fg);
        graphics_fill_rect(ctx, GRect(box_x + 3, 15, 8, 8), 0, GCornerNone);
      }
    }
  }

  graphics_context_set_text_color(ctx, fg);
  graphics_draw_text(ctx, s_choices[index].label,
                     fonts_get_system_font(FONT_KEY_GOTHIC_18),
                     GRect(text_x, 7, bounds.size.w - text_x - 8, 26),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}

static void choices_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *data) {
  GRect bounds = layer_get_bounds(cell_layer);
  bool highlighted = menu_cell_layer_is_highlighted(cell_layer);
  graphics_context_set_fill_color(ctx, highlighted ? list_highlight() : GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  if (choices_question_mode() && cell_index->row == 0) {
    draw_question_row(ctx, cell_layer, bounds, highlighted);
    return;
  }
  if (s_choice_count == 0) {
    graphics_context_set_text_color(ctx, highlighted ? list_highlight_text() : GColorBlack);
    graphics_draw_text(ctx, s_answer_pending ? "Sending..." : "No choices",
                       fonts_get_system_font(FONT_KEY_GOTHIC_18),
                       GRect(10, 8, bounds.size.w - 20, 24),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    return;
  }
  int index = (int)cell_index->row - choices_base_row();
  if (index < 0 || index >= s_choice_count) return;
  draw_choice_row(ctx, cell_layer, bounds, index, highlighted);
}
#else
static uint16_t choices_get_num_sections(MenuLayer *menu_layer, void *data) {
  return 1;
}

static uint16_t choices_get_num_rows(MenuLayer *menu_layer, uint16_t section_index, void *data) {
  return s_choice_count > 0 ? (uint16_t)s_choice_count : 1;
}

static int16_t choices_get_cell_height(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  return 40;
}

static void choices_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *data) {
  GRect bounds = layer_get_bounds(cell_layer);
  bool highlighted = menu_cell_layer_is_highlighted(cell_layer);
  graphics_context_set_fill_color(ctx, highlighted ? list_highlight() : GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  GColor fg = highlighted ? list_highlight_text() : GColorBlack;
  graphics_context_set_text_color(ctx, fg);
  if (s_choice_count == 0) {
    graphics_draw_text(ctx, s_answer_pending ? "Sending..." : "No choices",
                       fonts_get_system_font(FONT_KEY_GOTHIC_18),
                       GRect(10, 8, bounds.size.w - 20, 24),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    return;
  }
  if (cell_index->row >= (uint16_t)s_choice_count) return;
  int text_x = PBL_IF_ROUND_ELSE(48, 10);
  if (s_question_multi) {
    int box_x = PBL_IF_ROUND_ELSE(44, 9);
    if (!s_choices[cell_index->row].done) {
      GRect box = GRect(box_x, 12, 14, 14);
      graphics_context_set_stroke_color(ctx, fg);
      graphics_draw_rect(ctx, box);
      if (s_choices[cell_index->row].selected) {
        graphics_context_set_fill_color(ctx, fg);
        graphics_fill_rect(ctx, GRect(box_x + 3, 15, 8, 8), 0, GCornerNone);
      }
    }
    text_x = box_x + 23;
  }
  graphics_draw_text(ctx, s_choices[cell_index->row].label,
                     fonts_get_system_font(FONT_KEY_GOTHIC_18),
                     GRect(text_x, 7, bounds.size.w - text_x - 8, 26),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}
#endif

static void send_answer(int index) {
  if (s_answer_pending || index < 0 || index >= s_choice_count) return;
  s_answer_pending = true;
  menu_layer_reload_data(s_choice_menu);

  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    dict_write_uint8(out, MESSAGE_KEY_answer_req, 1);
    dict_write_cstring(out, MESSAGE_KEY_session_id, s_detail_session);
    dict_write_uint8(out, MESSAGE_KEY_choice_index, (uint8_t)index);
    app_message_outbox_send();
  } else {
    s_answer_pending = false;
    detail_show_reply_mode();
    set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
    show_reply_text("Could not send the answer. Press Back and try again.");
  }
}

static void send_permission_decision(int row) {
  if (s_answer_pending) return;
  if (!s_permission_request_id[0]) {
    detail_error("Permission request is no longer available.");
    return;
  }
  s_answer_pending = true;
  detail_show_reply_mode();
  set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
  show_reply_text(row == 1 ? "Approving permission..." : "Rejecting permission...");

  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    s_answer_pending = false;
    detail_error("Could not send the permission decision.");
    return;
  }
  dict_write_uint8(out, MESSAGE_KEY_permission_decision, 1);
  dict_write_cstring(out, MESSAGE_KEY_session_id, s_detail_session);
  dict_write_cstring(out, MESSAGE_KEY_permission_request_id, s_permission_request_id);
  dict_write_uint8(out, MESSAGE_KEY_permission_choice, (uint8_t)(row == 1 ? 0 : 1));
  app_message_outbox_send();
}

#ifndef PBL_PLATFORM_APLITE
static void layout_answer_detail(bool reset_offset) {
  if (!s_detail_scroll || !s_detail_text || !s_answer_label_text || !s_answer_description_text) return;
  if (s_answer_detail_choice < 0 || s_answer_detail_choice >= s_choice_count) return;
  Layer *root = window_get_root_layer(s_detail_window);
  GRect bounds = layer_get_bounds(root);
  int pad = PBL_IF_ROUND_ELSE(22, 4);
  int width = bounds.size.w - pad * 2;
  int y = 4;

  layer_set_hidden(text_layer_get_layer(s_detail_text), true);

  const char *label = s_choice_full_label[0] ? s_choice_full_label :
                      s_choices[s_answer_detail_choice].label;
  text_layer_set_text(s_answer_label_text, label);
  GSize a = text_size(label, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), width, true);
  layer_set_frame(text_layer_get_layer(s_answer_label_text), GRect(pad, y, width, a.h + 2));
  layer_set_hidden(text_layer_get_layer(s_answer_label_text), false);
  y += a.h + 4;

  const char *description = s_choice_description[0] ? s_choice_description :
                            s_choice_description_loading ? "Loading description..." : "No description.";
  text_layer_set_text(s_answer_description_text, description);
  GSize d = text_size(description, fonts_get_system_font(FONT_KEY_GOTHIC_14), width, true);
  layer_set_frame(text_layer_get_layer(s_answer_description_text), GRect(pad, y, width, d.h + 2));
  layer_set_hidden(text_layer_get_layer(s_answer_description_text), false);
  y += d.h + 8;

  scroll_layer_set_content_size(s_detail_scroll, GSize(bounds.size.w, y));
  if (reset_offset) {
    scroll_layer_set_content_offset(s_detail_scroll, GPoint(0, 0), false);
  } else {
    scroll_layer_set_content_offset(s_detail_scroll,
                                    scroll_layer_get_content_offset(s_detail_scroll), false);
  }
}

static void request_choice_detail(int index) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    s_choice_description_loading = false;
    if (s_detail_mode == DETAIL_ANSWER_TEXT) {
      layout_answer_detail(false);
    } else if (s_choice_menu) {
      menu_layer_reload_data(s_choice_menu);
    }
    return;
  }
  dict_write_uint8(out, MESSAGE_KEY_choice_detail_req, 1);
  dict_write_cstring(out, MESSAGE_KEY_session_id, s_detail_session);
  dict_write_uint8(out, MESSAGE_KEY_choice_index, (uint8_t)index);
  app_message_outbox_send();
}

static void detail_show_answer_text_mode(int index) {
  if (index < 0 || index >= s_choice_count) return;
  s_detail_mode = DETAIL_ANSWER_TEXT;
  question_marquee_stop();
  s_answer_detail_choice = index;
  s_choice_description[0] = '\0';
  s_choice_full_label[0] = '\0';
  s_choice_description_loading = true;
  set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
  layer_set_hidden(text_layer_get_layer(s_detail_header), false);
  layer_set_hidden(text_layer_get_layer(s_question_prompt), true);
  layer_set_hidden(menu_layer_get_layer(s_choice_menu), true);
  detail_scroll_frame(false);
  layer_set_hidden(scroll_layer_get_layer(s_detail_scroll), false);
  scroll_layer_set_click_config_onto_window(s_detail_scroll, s_detail_window);
  layout_answer_detail(true);
  request_choice_detail(index);
}

static void choices_select(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  if (choices_question_mode() && cell_index->row == 0) return;
  if (s_choice_count == 0) return;
  int index = (int)cell_index->row - choices_base_row();
  if (index < 0 || index >= s_choice_count) return;
  if (s_detail_mode == DETAIL_PERMISSION_DECISION) {
    send_permission_decision(index);
    return;
  }
#ifndef PBL_PLATFORM_APLITE
  if (s_detail_mode == DETAIL_SEND) {
    s_prompt_delivery = (uint8_t)index;
    start_prompt_upload();
    return;
  }
#endif
  send_answer(index);
}

static void choices_select_long(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  if (!choices_question_mode()) return;
  if (cell_index->row == 0) {
    detail_show_question_text_mode();
    return;
  }
  detail_show_answer_text_mode((int)cell_index->row - 1);
}

static void choices_selection_changed(MenuLayer *menu_layer, MenuIndex new_index,
                                     MenuIndex old_index, void *data) {
  if (choices_question_mode() && new_index.row == 0) {
    question_marquee_start();
  } else {
    question_marquee_stop();
  }
}
#else
static void choices_select(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  if (s_choice_count == 0) return;
  if (cell_index->row >= (uint16_t)s_choice_count) return;
  if (s_detail_mode == DETAIL_PERMISSION_DECISION) {
    send_permission_decision(cell_index->row);
    return;
  }
#ifndef PBL_PLATFORM_APLITE
  if (s_detail_mode == DETAIL_SEND) {
    s_prompt_delivery = (uint8_t)cell_index->row;
    start_prompt_upload();
    return;
  }
#endif
  send_answer(cell_index->row);
}

static void choices_select_long(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
}

static void choices_selection_changed(MenuLayer *menu_layer, MenuIndex new_index,
                                     MenuIndex old_index, void *data) {
}
#endif

static void result_pop(void *data) {
  s_result_timer = NULL;
  if (window_stack_get_top_window() == s_detail_window) {
    window_stack_pop(true);
  }
}

static void detail_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_header_bg = layer_create(GRect(0, 0, bounds.size.w, HEADER_HEIGHT));
  layer_set_update_proc(s_header_bg, header_bg_update);
  layer_add_child(root, s_header_bg);

  int header_pad = PBL_IF_ROUND_ELSE(34, 4);
  s_detail_header = text_layer_create(GRect(header_pad, HEADER_TOP,
                                             bounds.size.w - header_pad * 2,
                                             HEADER_HEIGHT - HEADER_TOP));
  text_layer_set_background_color(s_detail_header, GColorClear);
  text_layer_set_text_color(s_detail_header, GColorBlack);
  text_layer_set_font(s_detail_header, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_overflow_mode(s_detail_header, GTextOverflowModeWordWrap);
  text_layer_set_text_alignment(s_detail_header, GTextAlignmentLeft);
  layer_add_child(root, text_layer_get_layer(s_detail_header));

  s_detail_status_layer = layer_create(GRect(bounds.size.w - 32, 0, 26, HEADER_HEIGHT));
  layer_set_update_proc(s_detail_status_layer, detail_status_update);
  layer_add_child(root, s_detail_status_layer);

  s_header_rule = layer_create(GRect(0, HEADER_HEIGHT - 1, bounds.size.w, 1));
  layer_set_update_proc(s_header_rule, header_rule_update);
  layer_add_child(root, s_header_rule);

  s_detail_scroll = scroll_layer_create(GRect(0, DETAIL_BODY_Y, bounds.size.w,
                                               bounds.size.h - DETAIL_BODY_Y));
  scroll_layer_set_callbacks(s_detail_scroll, (ScrollLayerCallbacks){
    .click_config_provider = detail_scroll_click_config,
  });
  int body_pad = PBL_IF_ROUND_ELSE(22, 4);
  s_detail_text = text_layer_create(GRect(body_pad, 4, bounds.size.w - body_pad * 2, 5000));
  text_layer_set_font(s_detail_text, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_color(s_detail_text, GColorBlack);
  text_layer_set_background_color(s_detail_text, GColorClear);
  text_layer_set_overflow_mode(s_detail_text, GTextOverflowModeWordWrap);
  scroll_layer_add_child(s_detail_scroll, text_layer_get_layer(s_detail_text));
#ifndef PBL_PLATFORM_APLITE
  s_answer_label_text = text_layer_create(GRect(body_pad, 0, bounds.size.w - body_pad * 2, 0));
  text_layer_set_font(s_answer_label_text, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_color(s_answer_label_text, GColorBlack);
  text_layer_set_background_color(s_answer_label_text, GColorClear);
  text_layer_set_overflow_mode(s_answer_label_text, GTextOverflowModeWordWrap);
  layer_set_hidden(text_layer_get_layer(s_answer_label_text), true);
  scroll_layer_add_child(s_detail_scroll, text_layer_get_layer(s_answer_label_text));

  s_answer_description_text = text_layer_create(GRect(body_pad, 0, bounds.size.w - body_pad * 2, 0));
  text_layer_set_font(s_answer_description_text, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_color(s_answer_description_text, choice_subtext_color(false));
  text_layer_set_background_color(s_answer_description_text, GColorClear);
  text_layer_set_overflow_mode(s_answer_description_text, GTextOverflowModeWordWrap);
  layer_set_hidden(text_layer_get_layer(s_answer_description_text), true);
  scroll_layer_add_child(s_detail_scroll, text_layer_get_layer(s_answer_description_text));
#endif
  layer_add_child(root, scroll_layer_get_layer(s_detail_scroll));

  s_question_prompt = text_layer_create(GRect(body_pad, DETAIL_BODY_Y,
                                                bounds.size.w - body_pad * 2,
                                                QUESTION_PROMPT_HEIGHT - 4));
  text_layer_set_font(s_question_prompt, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_color(s_question_prompt, GColorBlack);
  text_layer_set_background_color(s_question_prompt, GColorClear);
  text_layer_set_overflow_mode(s_question_prompt, GTextOverflowModeTrailingEllipsis);
  layer_add_child(root, text_layer_get_layer(s_question_prompt));

  s_choice_menu = menu_layer_create(GRect(0, DETAIL_BODY_Y + QUESTION_PROMPT_HEIGHT,
                                           bounds.size.w,
                                           bounds.size.h - DETAIL_BODY_Y - QUESTION_PROMPT_HEIGHT));
  menu_layer_set_callbacks(s_choice_menu, NULL, (MenuLayerCallbacks){
    .get_num_sections = choices_get_num_sections,
    .get_num_rows = choices_get_num_rows,
    .get_cell_height = choices_get_cell_height,
    .draw_row = choices_draw_row,
    .select_click = choices_select,
    .select_long_click = choices_select_long,
    .selection_changed = choices_selection_changed,
  });
  menu_layer_set_normal_colors(s_choice_menu, GColorWhite, GColorBlack);
  menu_layer_set_highlight_colors(s_choice_menu, list_highlight(), list_highlight_text());
  layer_add_child(root, menu_layer_get_layer(s_choice_menu));

  s_detail_open = true;
  s_choice_count = 0;
  s_question_expected = 0;
#ifndef PBL_PLATFORM_APLITE
  s_question_description_len = 0;
  s_question_description[0] = '\0';
  s_question_description_expected = 0;
  s_question_description_next = 0;
  s_answer_detail_choice = -1;
  s_choice_description[0] = '\0';
  s_choice_full_label[0] = '\0';
  s_choice_description_loading = false;
#endif
  s_answer_pending = false;
  s_send_pending = false;
  s_prompt_uploading = false;
  s_reply_len = 0;
  s_reply_next = 0;
  s_reply_expected = 0;
  s_detail_message_id[0] = '\0';
  s_permission_request_id[0] = '\0';
  set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
  layout_detail_header();
  show_reply_text("Fetching session...");
  detail_show_reply_mode();
}

static void detail_window_unload(Window *window) {
  s_detail_open = false;
  s_send_pending = false;
  s_prompt_uploading = false;
#ifndef PBL_PLATFORM_APLITE
  question_marquee_stop();
#endif
#ifndef PBL_PLATFORM_APLITE
  if (s_dictation) dictation_session_stop(s_dictation);
#endif
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    dict_write_uint8(out, MESSAGE_KEY_detail_close, 1);
    dict_write_cstring(out, MESSAGE_KEY_session_id, s_detail_session);
    app_message_outbox_send();
  }
  if (s_result_timer) {
    app_timer_cancel(s_result_timer);
    s_result_timer = NULL;
  }
  text_layer_destroy(s_detail_header);
  s_detail_header = NULL;
  layer_destroy(s_detail_status_layer);
  s_detail_status_layer = NULL;
  layer_destroy(s_header_bg);
  s_header_bg = NULL;
  layer_destroy(s_header_rule);
  s_header_rule = NULL;
  scroll_layer_destroy(s_detail_scroll);
  s_detail_scroll = NULL;
  text_layer_destroy(s_detail_text);
  s_detail_text = NULL;
#ifndef PBL_PLATFORM_APLITE
  if (s_answer_label_text) {
    text_layer_destroy(s_answer_label_text);
    s_answer_label_text = NULL;
  }
  if (s_answer_description_text) {
    text_layer_destroy(s_answer_description_text);
    s_answer_description_text = NULL;
  }
#endif
  text_layer_destroy(s_question_prompt);
  s_question_prompt = NULL;
  menu_layer_destroy(s_choice_menu);
  s_choice_menu = NULL;
}

static void request_detail(const char *session_id, const char *name, uint8_t flags) {
  copy_clean(s_detail_session, sizeof(s_detail_session), session_id, true);
  copy_clean(s_detail_name, sizeof(s_detail_name), name ? name : "Session", true);
  s_detail_flags = flags;
  s_reply_len = 0;
  s_reply_next = 0;
  s_reply_expected = 0;
  s_choice_count = 0;
  s_question_expected = 0;
#ifndef PBL_PLATFORM_APLITE
  s_question_description_len = 0;
  s_question_description[0] = '\0';
  s_question_description_expected = 0;
  s_question_description_next = 0;
  s_answer_detail_choice = -1;
  s_choice_description[0] = '\0';
  s_choice_full_label[0] = '\0';
  s_choice_description_loading = false;
  question_marquee_stop();
#endif
  s_answer_pending = false;
  s_send_pending = false;
  s_prompt_uploading = false;
  s_detail_message_id[0] = '\0';
  s_permission_request_id[0] = '\0';

  if (window_stack_get_top_window() != s_detail_window) {
    window_stack_push(s_detail_window, true);
  } else if (s_detail_header) {
    set_detail_header(s_detail_name, "");
    show_reply_text("Fetching session...");
    detail_show_reply_mode();
    layout_detail_header();
  }
  if (detail_spinner_active() && !s_spin_timer) {
    s_spin_timer = app_timer_register(80, spinner_tick, NULL);
  }

  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    dict_write_uint8(out, MESSAGE_KEY_detail_req, 1);
    dict_write_cstring(out, MESSAGE_KEY_session_id, s_detail_session);
    app_message_outbox_send();
  }
}

// ---------------------------------------------------------------- incoming messages

#ifndef PBL_PLATFORM_APLITE
static size_t prompt_chunk_len(size_t offset) {
  if (offset >= s_prompt_len) return 0;
  size_t len = s_prompt_len - offset;
  if (len > PROMPT_CHUNK_BYTES) len = PROMPT_CHUNK_BYTES;
  while (len > 0 && offset + len < s_prompt_len &&
         ((unsigned char)s_prompt_text[offset + len] & 0xc0) == 0x80) {
    len--;
  }
  if (len == 0) len = 1;
  return len;
}

static int count_prompt_chunks(void) {
  int count = 0;
  size_t offset = 0;
  while (offset < s_prompt_len) {
    offset += prompt_chunk_len(offset);
    count++;
  }
  return count;
}

static void prompt_fail(const char *text) {
  s_prompt_uploading = false;
  s_send_pending = false;
  detail_error(text);
}

static void send_next_prompt_message(void) {
  if (!s_prompt_uploading) return;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    prompt_fail("Could not send the reply.");
    return;
  }

  if (s_prompt_phase == 0) {
    dict_write_uint8(out, MESSAGE_KEY_send_prompt_begin, 1);
    dict_write_cstring(out, MESSAGE_KEY_session_id, s_detail_session);
    dict_write_uint8(out, MESSAGE_KEY_send_delivery, s_prompt_delivery);
    dict_write_uint8(out, MESSAGE_KEY_send_prompt_count, (uint8_t)s_prompt_chunks);
    s_prompt_phase = 1;
  } else if (s_prompt_next < s_prompt_chunks) {
    size_t len = prompt_chunk_len(s_prompt_offset);
    char chunk[PROMPT_CHUNK_BYTES + 1];
    memcpy(chunk, s_prompt_text + s_prompt_offset, len);
    chunk[len] = '\0';
    dict_write_uint8(out, MESSAGE_KEY_send_prompt_index, (uint8_t)s_prompt_next);
    dict_write_cstring(out, MESSAGE_KEY_send_prompt_chunk, chunk);
    s_prompt_next++;
    s_prompt_offset += len;
  } else if (s_prompt_phase == 1) {
    dict_write_uint8(out, MESSAGE_KEY_send_prompt_end, 1);
    s_prompt_phase = 2;
  } else {
    s_prompt_uploading = false;
    return;
  }

  app_message_outbox_send();
}

static void start_prompt_upload(void) {
  if (!s_prompt_len) {
    prompt_fail("Reply is empty.");
    return;
  }
  s_prompt_chunks = count_prompt_chunks();
  if (s_prompt_chunks < 1 || s_prompt_chunks > 255) {
    prompt_fail("Reply is too long to send.");
    return;
  }
  s_prompt_offset = 0;
  s_prompt_next = 0;
  s_prompt_phase = 0;
  s_prompt_uploading = true;
  s_send_pending = true;
  detail_show_reply_mode();
  set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
  show_reply_text("Sending reply...");
  send_next_prompt_message();
}

static void outbox_sent(DictionaryIterator *iter, void *context) {
  if (!s_prompt_uploading) return;
  if (s_prompt_phase == 2) {
    s_prompt_phase = 3;
    s_prompt_uploading = false;
    return;
  }
  send_next_prompt_message();
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  if (s_prompt_uploading) prompt_fail("Could not send the reply.");
}

static const char *dictation_error_text(DictationSessionStatus status) {
  switch (status) {
    case DictationSessionStatusFailureTranscriptionRejected: return "Reply canceled.";
    case DictationSessionStatusFailureTranscriptionRejectedWithError: return "Dictation was rejected.";
    case DictationSessionStatusFailureSystemAborted: return "Dictation was interrupted.";
    case DictationSessionStatusFailureNoSpeechDetected: return "No speech detected.";
    case DictationSessionStatusFailureConnectivityError: return "Phone connection lost during dictation.";
    case DictationSessionStatusFailureDisabled: return "Dictation is disabled in the Pebble app.";
    case DictationSessionStatusFailureInternalError: return "Dictation failed.";
    case DictationSessionStatusFailureRecognizerError: return "Speech recognition failed.";
    default: return "Dictation failed.";
  }
}

static void dictation_callback(DictationSession *session, DictationSessionStatus status,
                              char *transcription, void *context) {
  if (!s_detail_open) return;
  if (status != DictationSessionStatusSuccess) {
    detail_error(dictation_error_text(status));
    return;
  }
  copy_clean(s_prompt_text, sizeof(s_prompt_text), transcription, false);
  s_prompt_len = strlen(s_prompt_text);
  if (!s_prompt_len) {
    detail_error("No speech detected.");
    return;
  }
  if (s_detail_flags & FLAG_RUNNING) {
    detail_show_send_mode();
  } else {
    s_prompt_delivery = 0;
    start_prompt_upload();
  }
}

static void handle_send_result(DictionaryIterator *iter) {
  if (!s_detail_open || !s_send_pending || !detail_matches(iter)) return;
  int ok = tuple_int(iter, MESSAGE_KEY_send_ok, 0);
  const char *text = tuple_string(iter, MESSAGE_KEY_send_result_text,
                                  ok ? "Reply sent." : "Could not send the reply.");
  s_send_pending = false;
  s_prompt_uploading = false;
  detail_show_reply_mode();
  set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
  show_incoming_text(text);
}
#endif

static void append_reply_chunk(const char *chunk) {
  if (!chunk || !chunk[0]) return;
  size_t len = strlen(chunk);
  if (s_reply_len + len + 1 >= sizeof(s_reply_buffer)) {
    len = sizeof(s_reply_buffer) - s_reply_len - 1;
    // Do not leave a half-written UTF-8 sequence at the end of the buffer.
    while (len > 0 && ((unsigned char)chunk[len] & 0xc0) == 0x80) len--;
    if (len > 0 && ((unsigned char)chunk[len - 1] & 0xc0) == 0xc0) len--;
  }
  memcpy(s_reply_buffer + s_reply_len, chunk, len);
  s_reply_len += len;
  s_reply_buffer[s_reply_len] = '\0';
}

#ifndef PBL_PLATFORM_APLITE
static void append_question_description(const char *chunk) {
  if (!chunk || !chunk[0]) return;
  size_t len = strlen(chunk);
  size_t used = (size_t)s_question_description_len;
  if (used + len + 1 >= sizeof(s_question_description)) {
    len = sizeof(s_question_description) - used - 1;
    while (len > 0 && ((unsigned char)chunk[len] & 0xc0) == 0x80) len--;
    if (len > 0 && ((unsigned char)chunk[len - 1] & 0xc0) == 0xc0) len--;
  }
  memcpy(s_question_description + used, chunk, len);
  s_question_description_len += (int)len;
  s_question_description[s_question_description_len] = '\0';
}
#endif

static void handle_list_begin(DictionaryIterator *iter) {
  s_incoming_count = 0;
  // Keep the current rows visible while the replacement list arrives. Clearing here caused the
  // "Connecting..." flash on every update.
  if (!s_have_list) {
    s_list_loading = true;
    if (s_list_menu) menu_layer_reload_data(s_list_menu);
  }
}

static void handle_list_session(DictionaryIterator *iter) {
  int index = tuple_int(iter, MESSAGE_KEY_index, -1);
  if (index < 0 || index >= MAX_SESSIONS) return;
  Session *session = &s_incoming[index];
  copy_clean(session->id, sizeof(session->id),
             tuple_string(iter, MESSAGE_KEY_session_id, ""), true);
  copy_clean(session->name, sizeof(session->name),
             tuple_string(iter, MESSAGE_KEY_session_name, "Untitled"), true);
  session->flags = (uint8_t)tuple_int(iter, MESSAGE_KEY_session_flags, 0);
  if (index + 1 > s_incoming_count) s_incoming_count = index + 1;
}

static void list_recalc_spinner(void) {
  s_has_spinner = false;
  for (int i = 0; i < s_session_count; i++) {
    if (session_shows_spinner(s_sessions[i].flags)) {
      s_has_spinner = true;
      break;
    }
  }
  if (s_has_spinner && !s_spin_timer) {
    s_spin_timer = app_timer_register(80, spinner_tick, NULL);
  }
}

static void handle_list_end(DictionaryIterator *iter) {
  memcpy(s_sessions, s_incoming, sizeof(s_sessions));
  s_session_count = s_incoming_count;
  if (s_session_count > MAX_SESSIONS) s_session_count = MAX_SESSIONS;
  s_list_loading = false;
  s_have_list = true;
  if (s_connect_timer) {
    app_timer_cancel(s_connect_timer);
    s_connect_timer = NULL;
  }

  const char *status = tuple_string(iter, MESSAGE_KEY_status_text, NULL);
  if (status) {
    copy_clean(s_status_text, sizeof(s_status_text), status, true);
  } else {
    snprintf(s_status_text, sizeof(s_status_text), "%d session%s", s_session_count,
             s_session_count == 1 ? "" : "s");
  }

  list_recalc_spinner();

  bool detail_found = false;
  for (int i = 0; i < s_session_count; i++) {
    if (s_detail_session[0] && strcmp(s_sessions[i].id, s_detail_session) == 0) {
      s_detail_flags = s_sessions[i].flags;
      detail_found = true;
      break;
    }
  }
  if (!detail_found) s_detail_flags = 0;
  if (s_detail_open) layout_detail_header();

  if ((s_has_spinner || detail_spinner_active()) && !s_spin_timer) {
    s_spin_timer = app_timer_register(80, spinner_tick, NULL);
  }
  if (s_list_menu) menu_layer_reload_data(s_list_menu);
  if (s_footer_layer) layer_mark_dirty(s_footer_layer);
}

static void spinner_tick(void *data) {
  s_spin_timer = NULL;
  if (!s_has_spinner && !detail_spinner_active()) return;
  s_spin_frame = (s_spin_frame + 1) % (int)ARRAY_LENGTH(SPINNER_GLYPHS);
  if (s_list_menu && window_stack_get_top_window() == s_list_window) {
    layer_mark_dirty(menu_layer_get_layer(s_list_menu));
  }
  if (s_detail_open && s_detail_status_layer &&
      window_stack_get_top_window() == s_detail_window) {
    layer_mark_dirty(s_detail_status_layer);
  }
  s_spin_timer = app_timer_register(80, spinner_tick, NULL);
}

static void handle_detail(DictionaryIterator *iter) {
  if (!s_detail_open || !detail_matches(iter)) return;
  int kind = tuple_int(iter, MESSAGE_KEY_detail_kind, 0);
  const char *title = tuple_string(iter, MESSAGE_KEY_detail_title, "Session");

  if (kind == DETAIL_QUESTION) {
    s_detail_message_id[0] = '\0';
    s_permission_request_id[0] = '\0';
    copy_clean(s_question_title, sizeof(s_question_title),
               tuple_string(iter, MESSAGE_KEY_question_title, title), true);
    copy_clean(s_question_field, sizeof(s_question_field),
               tuple_string(iter, MESSAGE_KEY_question_field, "Choose"), true);
    copy_clean(s_question_notice, sizeof(s_question_notice),
               tuple_string(iter, MESSAGE_KEY_question_notice, ""), true);
    s_question_multi = tuple_int(iter, MESSAGE_KEY_question_multi, 0) != 0;
    s_question_expected = tuple_int(iter, MESSAGE_KEY_question_count, 0);
#ifndef PBL_PLATFORM_APLITE
    s_question_description_len = 0;
    s_question_description[0] = '\0';
    s_question_description_expected = tuple_int(iter, MESSAGE_KEY_question_description_count, 0);
    s_question_description_next = 0;
      s_answer_detail_choice = -1;
    s_choice_description[0] = '\0';
    s_choice_full_label[0] = '\0';
    s_choice_description_loading = false;
#endif
    s_choice_count = 0;
    s_answer_pending = false;
    for (int i = 0; i < MAX_CHOICES; i++) {
      s_choices[i].label[0] = '\0';
      s_choices[i].selected = false;
      s_choices[i].done = false;
    }
    if (s_question_notice[0]) {
      snprintf(s_question_prompt_text, sizeof(s_question_prompt_text),
               "%.60s - %.35s - %.24s", s_question_title, s_question_field, s_question_notice);
    } else {
      snprintf(s_question_prompt_text, sizeof(s_question_prompt_text),
               "%.60s - %.40s", s_question_title, s_question_field);
    }
    text_layer_set_text(s_question_prompt, s_question_prompt_text);
    set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
    detail_show_question_mode();
    if (s_choice_menu) menu_layer_reload_data(s_choice_menu);
    return;
  }

  if (kind == DETAIL_MESSAGE) {
    s_detail_message_id[0] = '\0';
    s_permission_request_id[0] = '\0';
    const char *text = tuple_string(iter, MESSAGE_KEY_detail_text,
                                    "No latest reply is available for this session.");
    set_detail_header(title, "");
    detail_show_reply_mode();
    show_incoming_text(text);
    return;
  }

  if (kind == DETAIL_PERMISSION) {
    s_detail_message_id[0] = '\0';
    copy_clean(s_permission_request_id, sizeof(s_permission_request_id),
               tuple_string(iter, MESSAGE_KEY_permission_request_id, ""), true);
    const char *text = tuple_string(iter, MESSAGE_KEY_detail_text,
                                    "Permission request details unavailable.");
    set_detail_header(title, "");
    detail_show_permission_mode();
    show_incoming_text(text);
    return;
  }

  if (kind == DETAIL_REPLY) {
    s_permission_request_id[0] = '\0';
    copy_clean(s_detail_message_id, sizeof(s_detail_message_id),
               tuple_string(iter, MESSAGE_KEY_detail_message_id, ""), true);
    s_reply_len = 0;
    s_reply_next = 0;
    s_reply_expected = tuple_int(iter, MESSAGE_KEY_reply_count, 0);
    s_reply_buffer[0] = '\0';
    set_detail_header(title, "");
    detail_show_reply_mode();
    show_reply_text("Loading reply...");
    return;
  }
}

static void handle_reply_chunk(DictionaryIterator *iter) {
  if (!s_detail_open || s_detail_mode != DETAIL_REPLY || !detail_matches(iter)) return;
  int index = tuple_int(iter, MESSAGE_KEY_reply_index, -1);
  const char *chunk = tuple_string(iter, MESSAGE_KEY_reply_chunk, NULL);
  if (!chunk || index < 0) return;
  if (index == s_reply_next) {
    append_reply_chunk(chunk);
    s_reply_next++;
  }
}

static void request_mark_read(void) {
  if (!s_detail_message_id[0]) return;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_uint8(out, MESSAGE_KEY_mark_read, 1);
  dict_write_cstring(out, MESSAGE_KEY_session_id, s_detail_session);
  dict_write_cstring(out, MESSAGE_KEY_detail_message_id, s_detail_message_id);
  app_message_outbox_send();
}

static void handle_reply_end(DictionaryIterator *iter) {
  if (!s_detail_open || s_detail_mode != DETAIL_REPLY || !detail_matches(iter)) return;
  show_reply_text(s_reply_buffer);
  request_mark_read();
}

#ifndef PBL_PLATFORM_APLITE
static void handle_question_description(DictionaryIterator *iter) {
  if (!s_detail_open || s_detail_mode != DETAIL_QUESTION || !detail_matches(iter)) return;
  int index = tuple_int(iter, MESSAGE_KEY_question_description_index, -1);
  const char *chunk = tuple_string(iter, MESSAGE_KEY_question_description_chunk, NULL);
  if (index != s_question_description_next || !chunk) return;
  append_question_description(chunk);
  s_question_description_next++;
  if (s_choice_menu) menu_layer_reload_data(s_choice_menu);
  if (s_question_description_next >= s_question_description_expected) {
    question_marquee_start();
  }
}

static void handle_choice_detail(DictionaryIterator *iter) {
  if (!s_detail_open || s_detail_mode != DETAIL_ANSWER_TEXT || !detail_matches(iter)) return;
  if (s_answer_detail_choice < 0) return;
  int index = tuple_int(iter, MESSAGE_KEY_choice_index, s_answer_detail_choice);
  if (index != s_answer_detail_choice) return;
  copy_clean(s_choice_full_label, sizeof(s_choice_full_label),
             tuple_string(iter, MESSAGE_KEY_choice_label, s_choices[index].label), true);
  copy_clean(s_choice_description, sizeof(s_choice_description),
             tuple_string(iter, MESSAGE_KEY_choice_description, ""), true);
  s_choice_description_loading = false;
  layout_answer_detail(false);
}
#endif

static void handle_choice(DictionaryIterator *iter) {
  if (!s_detail_open || s_detail_mode != DETAIL_QUESTION || !detail_matches(iter)) return;
  int index = tuple_int(iter, MESSAGE_KEY_choice_index, -1);
  if (index < 0 || index >= MAX_CHOICES) return;
  copy_clean(s_choices[index].label, sizeof(s_choices[index].label),
             tuple_string(iter, MESSAGE_KEY_choice_label, ""), true);
  int flags = tuple_int(iter, MESSAGE_KEY_choice_flags, 0);
  s_choices[index].selected = (flags & 1) != 0;
  s_choices[index].done = (flags & 2) != 0;
  if (index + 1 > s_choice_count) s_choice_count = index + 1;
}

static void handle_question_end(DictionaryIterator *iter) {
  if (!s_detail_open || s_detail_mode != DETAIL_QUESTION || !detail_matches(iter)) return;
  int expected = tuple_int(iter, MESSAGE_KEY_question_count, s_choice_count);
  if (expected < 0) expected = 0;
  if (expected > MAX_CHOICES) expected = MAX_CHOICES;
  s_choice_count = expected;
  s_answer_pending = false;
  if (s_choice_menu) menu_layer_reload_data(s_choice_menu);
#ifndef PBL_PLATFORM_APLITE
  question_marquee_start();
#endif
}

static void handle_result(DictionaryIterator *iter) {
  int ok = tuple_int(iter, MESSAGE_KEY_result_ok, 0);
  const char *text = tuple_string(iter, MESSAGE_KEY_result_text, "");
  if (!s_detail_open || !s_detail_header || !detail_matches(iter)) return;
  s_answer_pending = false;

  if (ok) {
    detail_show_reply_mode();
    set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
    show_incoming_text(text && text[0] ? text : "OpenCode accepted the answer.");
    vibes_short_pulse();
    if (s_result_timer) app_timer_cancel(s_result_timer);
    s_result_timer = app_timer_register(1100, result_pop, NULL);
  } else {
    detail_show_reply_mode();
    set_detail_header(s_detail_name[0] ? s_detail_name : "Session", "");
    show_incoming_text(text && text[0] ? text : "Could not answer the question.");
  }
}

static void handle_clear_result(DictionaryIterator *iter) {
  int ok = tuple_int(iter, MESSAGE_KEY_clear_ok, 0);
  const char *text = tuple_string(iter, MESSAGE_KEY_clear_text,
                                  ok ? "Cleared" : "Could not clear status.");
  copy_clean(s_status_text, sizeof(s_status_text), text, true);
  if (s_footer_layer) layer_mark_dirty(s_footer_layer);
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  if (tuple_int(iter, MESSAGE_KEY_list_begin, 0)) {
    handle_list_begin(iter);
    return;
  }
  if (tuple_int(iter, MESSAGE_KEY_list_end, 0)) {
    handle_list_end(iter);
    return;
  }
  if (tuple_present(iter, MESSAGE_KEY_index) && tuple_present(iter, MESSAGE_KEY_session_id)) {
    handle_list_session(iter);
    return;
  }
  if (tuple_present(iter, MESSAGE_KEY_detail_kind)) {
    handle_detail(iter);
    return;
  }
  if (tuple_present(iter, MESSAGE_KEY_reply_chunk)) {
    handle_reply_chunk(iter);
    return;
  }
  if (tuple_int(iter, MESSAGE_KEY_reply_end, 0)) {
    handle_reply_end(iter);
    return;
  }
#ifndef PBL_PLATFORM_APLITE
  if (tuple_present(iter, MESSAGE_KEY_question_description_chunk)) {
    handle_question_description(iter);
    return;
  }
  if (tuple_present(iter, MESSAGE_KEY_choice_detail)) {
    handle_choice_detail(iter);
    return;
  }
#endif
  if (tuple_present(iter, MESSAGE_KEY_choice_label)) {
    handle_choice(iter);
    return;
  }
  if (tuple_int(iter, MESSAGE_KEY_question_end, 0)) {
    handle_question_end(iter);
    return;
  }
  if (tuple_present(iter, MESSAGE_KEY_result_ok)) {
    handle_result(iter);
    return;
  }
#ifndef PBL_PLATFORM_APLITE
  if (tuple_present(iter, MESSAGE_KEY_send_ok)) {
    handle_send_result(iter);
    return;
  }
#endif
  if (tuple_present(iter, MESSAGE_KEY_clear_ok)) {
    handle_clear_result(iter);
    return;
  }
  if (tuple_present(iter, MESSAGE_KEY_status_text)) {
    copy_clean(s_status_text, sizeof(s_status_text),
               tuple_string(iter, MESSAGE_KEY_status_text, ""), true);
    if (s_footer_layer) layer_mark_dirty(s_footer_layer);
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Inbox dropped: %d", (int)reason);
}

static void send_hello(void *data) {
  s_connect_timer = NULL;
  if (s_have_list) return;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    dict_write_uint8(out, MESSAGE_KEY_req, 1);
    app_message_outbox_send();
  }
  s_connect_timer = app_timer_register(3000, send_hello, NULL);
}

// ---------------------------------------------------------------- app lifecycle

static void init(void) {
  s_braille_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_BRAILLE_FONT_20));
#ifndef PBL_PLATFORM_APLITE
  s_dictation = dictation_session_create(PROMPT_TEXT_MAX, dictation_callback, NULL);
  if (s_dictation) {
    dictation_session_enable_confirmation(s_dictation, true);
    dictation_session_enable_error_dialogs(s_dictation, false);
  }
#endif
  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
#ifndef PBL_PLATFORM_APLITE
  app_message_register_outbox_sent(outbox_sent);
  app_message_register_outbox_failed(outbox_failed);
#endif
#ifdef PBL_PLATFORM_APLITE
  app_message_open(512, 512);
#else
  app_message_open(1024, 1024);
#endif

  s_list_window = window_create();
  window_set_background_color(s_list_window, GColorWhite);
  window_set_window_handlers(s_list_window, (WindowHandlers){
    .load = list_window_load,
    .unload = list_window_unload,
  });

  s_detail_window = window_create();
  window_set_background_color(s_detail_window, GColorWhite);
  window_set_window_handlers(s_detail_window, (WindowHandlers){
    .load = detail_window_load,
    .unload = detail_window_unload,
  });

  window_stack_push(s_list_window, false);
  app_timer_register(300, send_hello, NULL);
}

static void deinit(void) {
  if (s_spin_timer) app_timer_cancel(s_spin_timer);
  if (s_connect_timer) app_timer_cancel(s_connect_timer);
  if (s_result_timer) app_timer_cancel(s_result_timer);
#ifndef PBL_PLATFORM_APLITE
  question_marquee_stop();
#endif
#ifndef PBL_PLATFORM_APLITE
  if (s_dictation) dictation_session_destroy(s_dictation);
#endif
  if (s_braille_font) fonts_unload_custom_font(s_braille_font);
  window_destroy(s_detail_window);
  window_destroy(s_list_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
  return 0;
}
