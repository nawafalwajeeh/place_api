require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cors = require('cors');

// Initialize Firebase Admin
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

const db = admin.firestore();
const app = express();
const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

/**
 * UTILS: Ensuring all payload values are strings for FCM compatibility
 */
function convertToStringValues(obj) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value === null || value === undefined) {
            result[key] = '';
        } else if (typeof value === 'object') {
            try {
                result[key] = JSON.stringify(value);
            } catch {
                result[key] = String(value);
            }
        } else if (typeof value === 'boolean') {
            result[key] = value ? 'true' : 'false';
        } else if (typeof value === 'number') {
            result[key] = value.toString();
        } else {
            result[key] = String(value);
        }
    }
    return result;
}

function removeUndefined(obj) {
    if (!obj || typeof obj !== 'object') return {};
    return Object.fromEntries(
        Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null)
    );
}

/**
 * CORE: Send and Save Notifications
 */
async function sendAndLogNotification(recipientId, title, body, type, data = {}) {
    try {
        const userDoc = await db.collection('Users').doc(recipientId).get();
        if (!userDoc.exists) {
            console.warn(`[sendAndLogNotification] User ${recipientId} not found`);
            return false;
        }

        const fcmToken = userDoc.data()?.fcmToken;
        let senderAvatar = data.senderAvatar || '';
        const senderName = data.senderName || '';

        // Ensure all IDs are present or empty strings
        let targetId = data.targetId || '';
        let targetType = data.targetType || '';
        let postId = data.postId || '';
        let placeId = data.placeId || '';
        let reviewId = data.reviewId || '';
        let commentId = data.commentId || '';

        // PRO-LEVEL: Intelligent mapping if IDs are passed as generic targetId
        if (targetType === 'post' && !postId) postId = targetId;
        if (targetType === 'place' && !placeId) placeId = targetId;
        if (targetType === 'review' && !reviewId) reviewId = targetId;
        if (targetType === 'comment' && !commentId) commentId = targetId;

        // Reverse mapping for data consistency
        if (postId && !targetId) { targetId = postId; targetType = 'post'; }
        if (placeId && !targetId) { targetId = placeId; targetType = 'place'; }

        // avatar logic
        let hasAvatar = false;
        if (senderAvatar && senderAvatar.startsWith('http')) {
            hasAvatar = true;
        } else if (senderAvatar === '') {
            const initials = (senderName || 'U').charAt(0).toUpperCase();
            senderAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=1C59A4&color=fff&size=200&bold=true`;
            hasAvatar = true;
        }

        const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        let fcmMessageId = null;
        let delivered = false;

        if (fcmToken) {
            try {
                const message = {
                    token: fcmToken,
                    notification: {
                        title: senderName || title,
                        body: body,
                    },
                    data: convertToStringValues({
                        type: type,
                        recipientId: recipientId,
                        notificationId: notificationId,
                        senderAvatar: senderAvatar,
                        senderName: senderName,
                        senderId: data.senderId || '',
                        targetId: targetId,
                        targetType: targetType,
                        postId: postId,
                        placeId: placeId,
                        reviewId: reviewId,
                        commentId: commentId,
                        click_action: 'FLUTTER_NOTIFICATION_CLICK', // REQUIRED FOR DEEP LINK
                        appColor: '#1C59A4',
                        ...data
                    }),
                    android: {
                        priority: 'high',
                        notification: {
                            channelId: 'reviews_channel',
                            color: '#1C59A4',
                            sound: 'default',
                            icon: 'ic_notification',
                            clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                        }
                    },
                    apns: {
                        payload: {
                            aps: {
                                sound: 'default',
                                badge: 1,
                                'mutable-content': 1,
                                subtitle: senderName,
                            }
                        }
                    }
                };

                fcmMessageId = await admin.messaging().send(message);
                delivered = true;
            } catch (fcmError) {
                console.warn(`[sendAndLogNotification] FCM failed for ${recipientId}:`, fcmError.message);
            }
        }

        // Save to Firestore
        const notificationDoc = {
            id: notificationId,
            recipientId: recipientId,
            title: title,
            body: body,
            type: type,
            senderId: data.senderId || '',
            senderName: senderName,
            senderAvatar: senderAvatar,
            targetId: targetId,
            targetType: targetType,
            postId: postId,
            placeId: placeId,
            reviewId: reviewId,
            commentId: commentId,
            isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            delivered: delivered,
            fcmMessageId: fcmMessageId,
            data: removeUndefined(data),
        };

        await db.collection('Users').doc(recipientId).collection('Notifications').doc(notificationId).set(notificationDoc);
        return true;
    } catch (e) {
        console.error(`[sendAndLogNotification] Global Error:`, e.message);
        return false;
    }
}

/**
 * API ENDPOINTS
 */

// --- Register/Update FCM Token ---
app.post('/register-token', async (req, res) => {
    const { userId, fcmToken } = req.body;

    if (!userId || !fcmToken) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields'
        });
    }

    try {
        await db.collection('Users').doc(userId).set({
            fcmToken: fcmToken,
            fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        console.log(`✅ [API] Token registered for ${userId}`);
        res.status(200).json({
            success: true,
            message: 'FCM Token registered successfully'
        });
    } catch (e) {
        console.error(`❌ Error registering token:`, e);
        res.status(500).json({
            success: false,
            error: 'Failed to register FCM token'
        });
    }
});

// --- Manually Send Notification ---
app.post('/send-notification', async (req, res) => {
    try {
        const { toUserId, type, title, body, senderName, senderAvatar, targetId, targetType, extraData = {} } = req.body;

        if (!toUserId || !type || !title || !body) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        console.log(`📤 [API] Sending notification to ${toUserId}: ${title}`);

        const success = await sendAndLogNotification(toUserId, title, body, type, {
            senderName: senderName || '',
            senderAvatar: senderAvatar || '',
            targetId: targetId || '',
            targetType: targetType || '',
            ...extraData
        });

        if (success) {
            res.status(200).json({
                success: true,
                message: 'Notification sent and saved'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to send notification'
            });
        }
    } catch (error) {
        console.error(`❌ [API] Error:`, error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// --- Health Checks ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'Notification Server'
    });
});

app.get('/ping', (req, res) => {
    res.status(200).send('Server is awake!');
});

app.get('/', (req, res) => {
    res.send('Notification Server is running!');
});

// --- Debug/Test Endpoint ---
app.post('/test-notification', async (req, res) => {
    try {
        const { userId, type = 'test', title = 'Test', body = 'Test notification' } = req.body;

        const success = await sendAndLogNotification(
            userId,
            title,
            body,
            type,
            {
                senderId: 'test_sender',
                senderName: 'Test User',
                targetId: 'test_target',
                targetType: 'test',
                test: 'true'
            }
        );

        res.json({ success, message: success ? 'Test sent' : 'Failed' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * LISTENERS: Real-Time Engagement
 */

// 1. New Reviews Listener
function setupNewReviewListener() {
    db.collection('Reviews').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'added') {
                const review = change.doc.data();
                if (review.placeOwnerId && review.userId !== review.placeOwnerId) {
                    await sendAndLogNotification(
                        review.placeOwnerId,
                        'New Review',
                        `${review.userName} reviewed your place`,
                        'new_review',
                        {
                            senderId: review.userId,
                            senderName: review.userName,
                            senderAvatar: review.userAvatar,
                            targetId: review.placeId,
                            targetType: 'place',
                            placeId: review.placeId,
                            reviewId: change.doc.id
                        }
                    );
                }
            }
        });
    });
}

// 2. Comments Listener (Covers Reviews AND Posts)
function setupNewCommentListener() {
    // Listen to ALL Comments subcollections across the DB
    db.collectionGroup('Comments').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'added') {
                const comment = change.doc.data();
                const path = change.doc.ref.path;

                // CASE A: Top-level Comments collection (usually for Reviews)
                if (path.startsWith('Comments/')) {
                    if (comment.parentType === 'review') {
                        const reviewDoc = await db.collection('Reviews').doc(comment.parentId).get();
                        const review = reviewDoc.data();
                        if (review && comment.userId !== review.userId) {
                            await sendAndLogNotification(
                                review.userId,
                                'New Comment',
                                `${comment.userName} commented on your review`,
                                'new_comment',
                                {
                                    senderId: comment.userId,
                                    senderName: comment.userName,
                                    senderAvatar: comment.userAvatar,
                                    targetId: comment.parentId,
                                    targetType: 'review',
                                    placeId: review.placeId,
                                    reviewId: comment.parentId,
                                    commentId: change.doc.id
                                }
                            );
                        }
                    }
                }
                // CASE B: Post subcollection (Posts/{postId}/Comments/{id})
                else if (path.includes('Posts/')) {
                    const postId = path.split('/')[1];
                    const postDoc = await db.collection('Posts').doc(postId).get();
                    const post = postDoc.data();
                    if (post && comment.userId !== post.userId) {
                        await sendAndLogNotification(
                            post.userId,
                            'New Comment',
                            `${comment.userName} commented on your post`,
                            'new_comment',
                            {
                                senderId: comment.userId,
                                senderName: comment.userName,
                                senderAvatar: comment.userAvatar,
                                targetId: postId,
                                targetType: 'post',
                                postId: postId,
                                commentId: change.doc.id
                            }
                        );
                    }
                }

                // HANDLE REPLIES (Works for both)
                if (comment.parentCommentId) {
                    const parentDoc = await db.collectionGroup('Comments').where('id', '==', comment.parentCommentId).get();
                    if (!parentDoc.empty) {
                        const parent = parentDoc.docs[0].data();
                        if (parent && comment.userId !== parent.userId) {
                            await sendAndLogNotification(
                                parent.userId,
                                'New Reply',
                                `${comment.userName} replied to you`,
                                'comment_replied',
                                {
                                    senderId: comment.userId,
                                    senderName: comment.userName,
                                    senderAvatar: comment.userAvatar,
                                    targetId: comment.parentCommentId,
                                    targetType: 'comment',
                                    postId: comment.postId || '',
                                    placeId: parent.placeId || '',
                                    commentId: change.doc.id,
                                    parentCommentId: comment.parentCommentId
                                }
                            );
                        }
                    }
                }
            }
        });
    });
}

// 3. Post/Review Likes Listener
function setupLikeListeners() {
    // Reviews
    db.collection('Reviews').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'modified') {
                const review = change.doc.data();
                const oldReview = change.doc.previous?.data?.() || {};
                const newLikes = review.likes || [];
                const oldLikes = oldReview.likes || [];

                if (newLikes.length > oldLikes.length) {
                    const likerId = newLikes.find(l => !oldLikes.includes(l));
                    if (likerId && likerId !== review.userId) {
                        const liker = await db.collection('Users').doc(likerId).get();
                        await sendAndLogNotification(
                            review.userId,
                            'New Like',
                            `${liker.data()?.name || 'Someone'} liked your review`,
                            'review_liked',
                            {
                                senderId: likerId,
                                senderName: liker.data()?.name,
                                senderAvatar: liker.data()?.avatar,
                                targetId: change.doc.id,
                                targetType: 'review',
                                placeId: review.placeId,
                                reviewId: change.doc.id
                            }
                        );
                    }
                }
            }
        });
    });

    // Posts
    db.collection('Posts').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'modified') {
                const post = change.doc.data();
                const oldPost = change.doc.previous?.data?.() || {};
                const newLikes = post.likedBy || [];
                const oldLikes = oldPost.likedBy || [];

                if (newLikes.length > oldLikes.length) {
                    const likerId = newLikes.find(l => !oldLikes.includes(l));
                    if (likerId && likerId !== post.userId) {
                        const liker = await db.collection('Users').doc(likerId).get();
                        await sendAndLogNotification(
                            post.userId,
                            'New Like',
                            `${liker.data()?.name || 'Someone'} liked your post`,
                            'post_liked',
                            {
                                senderId: likerId,
                                senderName: liker.data()?.name,
                                senderAvatar: liker.data()?.avatar,
                                targetId: change.doc.id,
                                targetType: 'post',
                                postId: change.doc.id
                            }
                        );
                    }
                }
            }
        });
    });
}

// 4. New Followers Listener
const userFollowersCache = {};

function setupNewFollowerListener() {
    console.log('[Listener] Setting up listener for new followers...');

    db.collection('Users').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'modified') {
                const userId = change.doc.id;
                const newUserData = change.doc.data();

                // Note: onSnapshot changes don't have built-in "previous" data in Firestore Node SDK 
                // in the same way as functions. We rely on comparing fields if available or use a cache.
                const newFollowers = newUserData.followers || [];
                const oldFollowerCount = userFollowersCache[userId] || 0;

                if (newFollowers.length > oldFollowerCount) {
                    const newFollowerId = newFollowers[newFollowers.length - 1];

                    if (newFollowerId && newFollowerId !== userId) {
                        const followerDoc = await db.collection('Users').doc(newFollowerId).get();
                        const followerData = followerDoc.data();

                        await sendAndLogNotification(
                            userId,
                            'New Follower',
                            `${followerData?.name || 'Someone'} started following you`,
                            'new_follower',
                            {
                                senderId: newFollowerId,
                                senderName: followerData?.name || 'User',
                                senderAvatar: followerData?.avatar || '',
                                targetId: newFollowerId,
                                targetType: 'user'
                            }
                        );
                    }
                }

                userFollowersCache[userId] = newFollowers.length;
            }
        });
    }, err => {
        console.error('[Listener Error] New Followers:', err);
    });
}

/**
 * INITIALIZATION
 */
app.listen(PORT, HOST, () => {
    console.log(`🚀 Notification Server running on http://${HOST}:${PORT}`);
    setupNewReviewListener();
    setupNewCommentListener();
    setupNewFollowerListener();
    setupLikeListeners();
});
