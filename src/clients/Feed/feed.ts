import { Channel } from "phoenix";
import { StoreApi } from "zustand";
import EventEmitter from "eventemitter3";
import ApiClient from "../../api";
import createStore from "./store";
import {
  FeedMessagesReceivedPayload,
  FeedRealTimeCallback,
  FeedRealTimeEvent,
  FeedItemOrItems,
  FeedStoreState,
} from "./types";
import {
  FeedItem,
  FeedClientOptions,
  FetchFeedOptions,
  FeedResponse,
} from "./interfaces";
import Knock from "../../knock";
import { isRequestInFlight, NetworkStatus } from "../../networkStatus";

export type Status =
  | "seen"
  | "read"
  | "archived"
  | "unseen"
  | "unread"
  | "unarchived";

class Feed {
  private apiClient: ApiClient;
  private userFeedId: string;
  private channelConnected = false;
  private channel: Channel;
  private broadcaster: EventEmitter;
  private defaultOptions: FeedClientOptions;

  // The raw store instance, used for binding in React and other environments
  public store: StoreApi<FeedStoreState>;

  constructor(
    readonly knock: Knock,
    readonly feedId: string,
    options: FeedClientOptions,
  ) {
    this.apiClient = knock.client();
    this.feedId = feedId;
    this.userFeedId = this.buildUserFeedId();
    this.store = createStore();
    this.broadcaster = new EventEmitter();
    this.defaultOptions = options;

    // Try and connect to the socket
    this.apiClient.connectSocket();

    this.channel = this.apiClient.createChannel(
      `feeds:${this.userFeedId}`,
      this.defaultOptions,
    );
  }

  /*
    Returns a socket to listen for feed updates
  */
  listenForUpdates() {
    if (!this.channelConnected) {
      this.channel.join().receive("ok", () => {
        this.channelConnected = true;
      });

      this.channel.on("new-message", (resp) => this.onNewMessageReceived(resp));
    }

    return () => {
      try {
        this.channel.leave();
      } catch (e) {
        // tslint:disable-next-line
        console.error("error while leaving channel", e);
      }
    };
  }

  /* Binds a handler to be invoked when event occurs */
  on(eventName: FeedRealTimeEvent, callback: FeedRealTimeCallback) {
    this.broadcaster.on(eventName, callback);
  }

  off(eventName: FeedRealTimeEvent, callback: FeedRealTimeCallback) {
    this.broadcaster.off(eventName, callback);
  }

  getState() {
    return this.store.getState();
  }

  async markAsSeen(itemOrItems: FeedItemOrItems) {
    const now = new Date().toISOString();
    this.optimisticallyPerformStatusUpdate(
      itemOrItems,
      "seen",
      { seen_at: now },
      "unseen_count",
    );
    return this.makeStatusUpdate(itemOrItems, "seen");
  }

  async markAsUnseen(itemOrItems: FeedItemOrItems) {
    this.optimisticallyPerformStatusUpdate(
      itemOrItems,
      "unseen",
      { seen_at: null },
      "unseen_count",
    );
    return this.makeStatusUpdate(itemOrItems, "unseen");
  }

  async markAsRead(itemOrItems: FeedItemOrItems) {
    const now = new Date().toISOString();
    this.optimisticallyPerformStatusUpdate(
      itemOrItems,
      "read",
      { read_at: now },
      "unread_count",
    );
    return this.makeStatusUpdate(itemOrItems, "read");
  }

  async markAsUnread(itemOrItems: FeedItemOrItems) {
    this.optimisticallyPerformStatusUpdate(
      itemOrItems,
      "unread",
      { read_at: null },
      "unread_count",
    );
    return this.makeStatusUpdate(itemOrItems, "unread");
  }

  /*
  Marking one or more items as archived should:

  - Decrement the badge count for any unread / unseen items
  - Remove the item from the feed list, when the include_archived flag is not true)

  TODO: how do we handle rollbacks?
  */
  async markAsArchived(itemOrItems: FeedItemOrItems) {
    const { getState, setState } = this.store;
    const state = getState();
    const shouldRemoveItems = this.defaultOptions.include_archived !== true;

    const normalizedItems = Array.isArray(itemOrItems)
      ? itemOrItems
      : [itemOrItems];

    const itemIds: string[] = normalizedItems.map((item) => item.id);

    // If any of the items are unseen or unread, then capture as we'll want to decrement
    // the counts for these in the metadata we have
    const unseenCount = normalizedItems.filter((i) => !i.seen_at).length;
    const unreadCount = normalizedItems.filter((i) => !i.read_at).length;

    // Build the new metadata
    const meta = {
      ...state.metadata,
      total_count: state.metadata.total_count - normalizedItems.length,
      unseen_count: state.metadata.unseen_count - unseenCount,
      unread_count: state.metadata.unread_count - unreadCount,
    };

    // Perform optimistic updates on the items in the feed
    if (shouldRemoveItems) {
      // Filter the items out of the list
      const entries = state.items.filter((item) => !itemIds.includes(item.id));

      setState((state) =>
        state.setResult({ entries, meta, page_info: state.pageInfo }),
      );
    } else {
      setState((state) => {
        state.setMetadata(meta);
        state.setItemAttrs(itemIds, { archived_at: new Date().toISOString() });
      });
    }

    return this.makeStatusUpdate(itemOrItems, "archived");
  }

  async markAsUnarchived(itemOrItems: FeedItemOrItems) {
    this.optimisticallyPerformStatusUpdate(itemOrItems, "unarchived", {
      archived_at: null,
    });
    return this.makeStatusUpdate(itemOrItems, "unarchived");
  }

  /* Fetches the feed content, appending it to the store */
  async fetch(options: FetchFeedOptions = {}) {
    const { setState, getState } = this.store;
    const { networkStatus } = getState();

    // If there's an existing request in flight, then do nothing
    if (isRequestInFlight(networkStatus)) {
      return;
    }

    // Set the loading type based on the request type it is
    setState((store) =>
      store.setNetworkStatus(options.__loadingType ?? NetworkStatus.loading),
    );

    // Always include the default params, if they have been set
    const queryParams = { ...this.defaultOptions, ...options };

    const result = await this.apiClient.makeRequest({
      method: "GET",
      url: `/v1/users/${this.knock.userId}/feeds/${this.feedId}`,
      params: queryParams,
    });

    if (result.statusCode === "error" || !result.body) {
      setState((store) => store.setNetworkStatus(NetworkStatus.error));

      return {
        status: result.statusCode,
        data: result.error || result.body,
      };
    }

    const response = {
      entries: result.body.entries,
      meta: result.body.meta,
      page_info: result.body.page_info,
    };

    if (options.before) {
      const opts = { shouldSetPage: false, shouldAppend: true };
      setState((state) => state.setResult(response, opts));
    } else if (options.after) {
      const opts = { shouldSetPage: true, shouldAppend: true };
      setState((state) => state.setResult(response, opts));
    } else {
      setState((state) => state.setResult(response));
    }

    this.broadcast("messages.new", response);
    return { data: response, status: result.statusCode };
  }

  async fetchNextPage() {
    // Attempts to fetch the next page of results (if we have any)
    const { getState } = this.store;
    const { pageInfo } = getState();

    if (!pageInfo.after) {
      // Nothing more to fetch
      return;
    }

    this.fetch({
      after: pageInfo.after,
      __loadingType: NetworkStatus.fetchMore,
    });
  }

  private broadcast(eventName: FeedRealTimeEvent, data: FeedResponse) {
    this.broadcaster.emit(eventName, data);
  }

  // Invoked when a new real-time message comes in from the socket
  private async onNewMessageReceived({
    metadata,
  }: FeedMessagesReceivedPayload) {
    // Handle the new message coming in
    const { getState, setState } = this.store;
    const { items } = getState();
    const currentHead: FeedItem | undefined = items[0];
    // Optimistically set the badge counts
    setState((state) => state.setMetadata(metadata));
    // Fetch the items before the current head (if it exists)
    this.fetch({ before: currentHead?.__cursor });
  }

  private buildUserFeedId() {
    return `${this.feedId}:${this.knock.userId}`;
  }

  private optimisticallyPerformStatusUpdate(
    itemOrItems: FeedItemOrItems,
    type: Status,
    attrs: object,
    badgeCountAttr?: "unread_count" | "unseen_count",
  ) {
    const { getState, setState } = this.store;
    const itemIds = Array.isArray(itemOrItems)
      ? itemOrItems.map((item) => item.id)
      : [itemOrItems.id];

    if (badgeCountAttr) {
      const { metadata } = getState();

      // Tnis is a hack to determine the direction of whether we're
      // adding or removing from the badge count
      const direction = type.startsWith("un")
        ? itemIds.length
        : -itemIds.length;

      setState((store) =>
        store.setMetadata({
          ...metadata,
          [badgeCountAttr]: Math.max(0, metadata[badgeCountAttr] + direction),
        }),
      );
    }

    // Update the items with the given attributes
    setState((store) => store.setItemAttrs(itemIds, attrs));
  }

  private async makeStatusUpdate(itemOrItems: FeedItemOrItems, type: Status) {
    // If we're interacting with an array, then we want to send this as a batch
    if (Array.isArray(itemOrItems)) {
      const itemIds = itemOrItems.map((item) => item.id);

      return await this.apiClient.makeRequest({
        method: "POST",
        url: `/v1/messages/batch/${type}`,
        data: { message_ids: itemIds },
      });
    }

    // If its a single then we can just call the regular endpoint
    const result = await this.apiClient.makeRequest({
      method: type.startsWith("un") ? "DELETE" : "PUT",
      url: `/v1/messages/${itemOrItems.id}/${type}`,
    });

    return result;
  }
}

export default Feed;
