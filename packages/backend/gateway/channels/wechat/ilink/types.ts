export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  update_time_ms?: number
  delete_time_ms?: number
  session_id?: string
  group_id?: string
  from_user_name?: string
  from_user_nickname?: string
  from_user_nick_name?: string
  from_user_remark_name?: string
  sender_name?: string
  sender_nickname?: string
  nickname?: string
  nick_name?: string
  remark_name?: string
  username?: string
  alias?: string
  wechat_id?: string
  avatar_url?: string
  avatarUrl?: string
  head_img_url?: string
  headimgurl?: string
  message_type?: number
  message_state?: number
  context_token?: string
  run_id?: string
  item_list?: Array<{
    type?: number
    text_item?: { text: string }
  }>
}

export interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  sync_buf?: string
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}
