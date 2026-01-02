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




//---------Previous Original code--------------
// require('dotenv').config();
// const express = require('express');
// const admin = require('firebase-admin');
// const bodyParser = require('body-parser');
// const cors = require('cors');

// // Initialize Firebase Admin
// if (!admin.apps.length) {
//   const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
//   admin.initializeApp({
//     credential: admin.credential.cert(serviceAccount),
//   });
// }

// const db = admin.firestore();
// const app = express();
// const HOST = process.env.HOST || '0.0.0.0';
// const PORT = process.env.PORT || 3000;

// app.use(cors());
// app.use(bodyParser.json());



// // Make sure this function exists in your server code:
// function convertToStringValues(obj) {
//   const result = {};
//   for (const [key, value] of Object.entries(obj)) {
//     if (value === null || value === undefined) {
//       result[key] = '';
//     } else if (typeof value === 'object') {
//       // For objects and arrays, stringify them
//       try {
//         result[key] = JSON.stringify(value);
//       } catch {
//         result[key] = String(value);
//       }
//     } else if (typeof value === 'boolean') {
//       // Convert boolean to string
//       result[key] = value ? 'true' : 'false';
//     } else if (typeof value === 'number') {
//       // Convert number to string
//       result[key] = value.toString();
//     } else {
//       // Already a string or other type
//       result[key] = String(value);
//     }
//   }
//   return result;
// }

// // And the removeUndefined function:
// function removeUndefined(obj) {
//     if (!obj || typeof obj !== 'object') return {};
//     return Object.fromEntries(
//         Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null)
//     );
// }

// // Send and Save Notifications - Improved to handle missing tokens
// async function sendAndLogNotification(recipientId, title, body, type, data = {}) {
//     try {
//         const userDoc = await db.collection('Users').doc(recipientId).get();
//         if (!userDoc.exists) {
//             console.warn(`[sendAndLogNotification] User ${recipientId} not found in Firestore`);
//             return false;
//         }

//         const fcmToken = userDoc.data()?.fcmToken;
//         let senderAvatar = data.senderAvatar || '';
//         const senderName = data.senderName || '';
//         const targetId = data.targetId || '';
//         const targetType = data.targetType || '';

//         // Validate and clean avatar URL
//         let hasAvatar = false;
//         if (senderAvatar && senderAvatar.startsWith('http')) {
//             if (!senderAvatar.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i)) {
//                 senderAvatar = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(senderName || 'User') + '&background=1C59A4&color=fff&size=200';
//             }
//             hasAvatar = true;
//         } else if (senderAvatar === '') {
//             const initials = (senderName || 'U').charAt(0).toUpperCase();
//             senderAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=1C59A4&color=fff&size=200&bold=true`;
//             hasAvatar = true;
//         }

//         const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

//         // Attempt to send FCM only if token exists
//         let fcmMessageId = null;
//         let delivered = false;

//         if (fcmToken) {
//             try {
//                 const message = {
//                     token: fcmToken,
//                     notification: { 
//                         title: senderName || title,
//                         body: body,
//                         ...(hasAvatar && { 
//                             imageUrl: `${senderAvatar}${senderAvatar.includes('?') ? '&' : '?'}size=400x400`
//                         })
//                     },
//                     data: convertToStringValues({
//                         type: type,
//                         recipientId: recipientId,
//                         notificationId: notificationId,
//                         senderAvatar: senderAvatar,
//                         senderName: senderName,
//                         senderId: data.senderId || '',
//                         targetId: targetId,
//                         targetType: targetType,
//                         title: title,
//                         body: body,
//                         appColor: '#1C59A4',
//                         ...data
//                     }),
//                     android: {
//                         priority: 'high',
//                         notification: {
//                             channelId: 'reviews_channel',
//                             color: '#1C59A4',
//                             sound: 'default',
//                             icon: 'ic_notification',
//                             clickAction: 'FLUTTER_NOTIFICATION_CLICK',
//                             tag: notificationId,
//                             ...(hasAvatar && { image: `${senderAvatar}${senderAvatar.includes('?') ? '&' : '?'}w=400&h=400&fit=crop` }),
//                         }
//                     },
//                     apns: {
//                         payload: {
//                             aps: {
//                                 sound: 'default',
//                                 badge: 1,
//                                 'mutable-content': hasAvatar ? 1 : 0,
//                                 subtitle: senderName,
//                                 category: 'MESSAGE_CATEGORY',
//                             }
//                         },
//                         fcmOptions: {
//                             imageUrl: hasAvatar ? `${senderAvatar}${senderAvatar.includes('?') ? '&' : '?'}w=400&h=400&fit=crop` : undefined,
//                         }
//                     }
//                 };

//                 fcmMessageId = await admin.messaging().send(message);
//                 delivered = true;
//                 console.log(`[sendAndLogNotification] ✅ FCM sent to ${recipientId}`);
//             } catch (fcmError) {
//                 console.warn(`[sendAndLogNotification] ⚠️ FCM delivery failed for ${recipientId}:`, fcmError.message);
//                 // We continue so it still gets saved to Firestore
//             }
//         } else {
//             console.warn(`[sendAndLogNotification] ℹ️ No FCM token for user ${recipientId}. Skipping FCM send.`);
//         }

//         // ALWAYS Save to Firestore (The user will see it in-app)
//         const notificationDoc = {
//             id: notificationId,
//             recipientId: recipientId,
//             title: title,
//             body: body,
//             type: type,
//             senderId: data.senderId || '',
//             senderName: senderName,
//             senderAvatar: senderAvatar,
//             targetId: targetId,
//             targetType: targetType,
//             isRead: false,
//             timestamp: admin.firestore.FieldValue.serverTimestamp(),
//             delivered: delivered,
//             fcmMessageId: fcmMessageId,
//             data: removeUndefined(data),
//         };

//         await db.collection('Users')
//             .doc(recipientId)
//             .collection('Notifications')
//             .doc(notificationId)
//             .set(notificationDoc);

//         console.log(`[sendAndLogNotification] ✅ Saved to Firestore for ${recipientId}`);
        
//         return true; // We return true because it was at least saved to Firestore

//     } catch (e) {
//         console.error(`[sendAndLogNotification] ❌ Global Error:`, e.message);
//         return false;
//     }
// }

// // Fallback function without style/picture
// async function sendSimpleNotification(recipientId, title, body, type, data = {}) {
//     try {
//         const userDoc = await db.collection('Users').doc(recipientId).get();
//         const fcmToken = userDoc.data()?.fcmToken;

//         if (!fcmToken) return false;

//         const senderName = data.senderName || '';
//         const initials = (senderName || 'U').charAt(0).toUpperCase();
//         const systemAvatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=1C59A4&color=fff&size=256&bold=true&format=png`;

//         const message = {
//             token: fcmToken,
//             notification: { 
//                 title: senderName || title,
//                 body: body,
//                 imageUrl: systemAvatarUrl
//             },
//             data: convertToStringValues({
//                 type: type,
//                 recipientId: recipientId,
//                 senderAvatar: systemAvatarUrl,
//                 senderName: senderName,
//                 ...data
//             }),
//             android: {
//                 priority: 'high',
//                 notification: {
//                     channelId: 'reviews_channel',
//                     color: '#1C59A4',
//                     sound: 'default',
//                     icon: systemAvatarUrl, // This shows circular avatar!
//                     clickAction: 'FLUTTER_NOTIFICATION_CLICK',
//                 }
//             },
//             apns: {
//                 payload: {
//                     aps: {
//                         sound: 'default',
//                         badge: 1,
//                         'mutable-content': 1,
//                         subtitle: senderName,
//                     }
//                 }
//             }
//         };

//         await admin.messaging().send(message);
//         console.log(`[sendSimpleNotification] ✅ Simple notification with avatar sent`);
//         return true;
        
//     } catch (e) {
//         console.error(`[sendSimpleNotification] ❌ Error:`, e.message);
//         return false;
//     }
// }

// // --- API Endpoint to Register/Update FCM Token ---
// app.post('/register-token', async (req, res) => {
//     const { userId, fcmToken } = req.body;

//     if (!userId || !fcmToken) {
//         console.warn(`[API /register-token] Missing required fields: userId, fcmToken`);
//         return res.status(400).json({ 
//             success: false, 
//             error: 'Missing required fields: userId, fcmToken' 
//         });
//     }

//     try {
//         await db.collection('Users').doc(userId).set({
//             fcmToken: fcmToken,
//             fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         }, { merge: true });
//         console.log(`[API /register-token] FCM Token registered/updated for user ${userId}`);
//         res.status(200).json({ 
//             success: true, 
//             message: 'FCM Token registered successfully.' 
//         });
//     } catch (e) {
//         console.error(`[API /register-token] Error registering FCM token for ${userId}: ${e.message}`);
//         res.status(500).json({ 
//             success: false, 
//             error: 'Failed to register FCM token.' 
//         });
//     }
// });

// // --- API Endpoint to Manually Send Notification ---
// app.post('/send-notification', async (req, res) => {
//     const { toUserId, type, title, body, senderName, senderAvatar, targetId, targetType, extraData = {} } = req.body;

//     if (!toUserId || !type || !title || !body) {
//         console.warn(`[API /send-notification] Missing required fields`);
//         return res.status(400).json({ 
//             success: false, 
//             error: 'Missing required fields: toUserId, type, title, body' 
//         });
//     }

//     try {
//         console.log(`[API /send-notification] Sending notification to user ${toUserId}`);
//         console.log(`[API /send-notification] Type: ${type}, Title: ${title}`);
        
//         const success = await sendAndLogNotification(toUserId, title, body, type, {
//             senderName: senderName || '',
//             senderAvatar: senderAvatar || '',
//             targetId: targetId || '',
//             targetType: targetType || '',
//             ...extraData
//         });
        
//         if (success) {
//             res.status(200).json({ 
//                 success: true, 
//                 message: 'Notification sent and saved' 
//             });
//         } else {
//             res.status(500).json({ 
//                 success: false, 
//                 error: 'Failed to send notification. Check server logs for details.' 
//             });
//         }
//     } catch (error) {
//         console.error(`[API /send-notification] Error: ${error.message}`);
//         res.status(500).json({ 
//             success: false, 
//             error: 'Internal server error',
//             details: error.message
//         });
//     }
// });

// // --- Firestore Listeners for Real-Time Events ---
// // 1. Listener for new reviews
// function setupNewReviewListener() {
//     console.log('[Listener] Setting up listener for new reviews...');
    
//     db.collection('Reviews').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'added') {
//                 const newReview = change.doc.data();
//                 const reviewId = change.doc.id;
                
//                 console.log(`[Listener] New review added: ${reviewId} for place: ${newReview.placeId}`);
                
//                 // Notify place owner about new review
//                 if (newReview.userId && newReview.placeOwnerId && newReview.userId !== newReview.placeOwnerId) {
//                     await sendAndLogNotification(
//                         newReview.placeOwnerId,
//                         'New Review on Your Place',
//                         `${newReview.userName || 'Someone'} reviewed your place`,
//                         'new_review',
//                         {
//                             senderId: newReview.userId,
//                             senderName: newReview.userName || 'User',
//                             senderAvatar: newReview.userAvatar || '',
//                             targetId: newReview.placeId,
//                             targetType: 'place',
//                             placeId: newReview.placeId,
//                             reviewId: reviewId,
//                             rating: String(newReview.rating || 0),
//                             reviewText: newReview.reviewText?.substring(0, 100) || ''
//                         }
//                     );
//                 }
//             }
//         });
//     }, err => {
//         console.error('[Listener Error] New Reviews:', err);
//     });
// }

// // 2. Listener for review likes
// const reviewLikesCache = {};

// function setupReviewLikeListener() {
//     console.log('[Listener] Setting up listener for review likes...');
    
//     db.collection('Reviews').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'modified') {
//                 const reviewId = change.doc.id;
//                 const newReview = change.doc.data();
//                 const oldReview = change.doc.previous?.data?.() || {};
                
//                 const newLikes = newReview.likes || [];
//                 const oldLikes = oldReview.likes || [];
                
//                 // Check if likes count changed
//                 if (newLikes.length > oldLikes.length) {
//                     // Find the new liker
//                     const newLikerId = newLikes.find(like => !oldLikes.includes(like));
                    
//                     if (newLikerId && newLikerId !== newReview.userId) {
//                         // Get liker info
//                         const likerDoc = await db.collection('Users').doc(newLikerId).get();
//                         const likerData = likerDoc.data();
                        
//                         await sendAndLogNotification(
//                             newReview.userId,
//                             'Your Review Got Liked',
//                             `${likerData?.name || 'Someone'} liked your review`,
//                             'review_liked',
//                             {
//                                 senderId: newLikerId,
//                                 senderName: likerData?.name || 'User',
//                                 senderAvatar: likerData?.avatar || '',
//                                 targetId: reviewId,
//                                 targetType: 'review',
//                                 placeId: newReview.placeId,
//                                 reviewId: reviewId,
//                                 likeCount: String(newLikes.length)
//                             }
//                         );
//                     }
//                 }
                
//                 // Update cache
//                 reviewLikesCache[reviewId] = newLikes.length;
//             }
//         });
//     }, err => {
//         console.error('[Listener Error] Review Likes:', err);
//     });
// }

// // 3. Listener for new comments
// function setupNewCommentListener() {
//     console.log('[Listener] Setting up listener for new comments...');
    
//     db.collection('Comments').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'added') {
//                 const newComment = change.doc.data();
//                 const commentId = change.doc.id;
                
//                 console.log(`[Listener] New comment added: ${commentId}`);
                
//                 // Notify review author if comment is on their review
//                 if (newComment.parentType === 'review') {
//                     const reviewDoc = await db.collection('Reviews').doc(newComment.parentId).get();
//                     const review = reviewDoc.data();
                    
//                     if (review && newComment.userId !== review.userId) {
//                         await sendAndLogNotification(
//                             review.userId,
//                             'New Comment on Your Review',
//                             `${newComment.userName || 'Someone'} commented on your review`,
//                             'new_comment',
//                             {
//                                 senderId: newComment.userId,
//                                 senderName: newComment.userName || 'User',
//                                 senderAvatar: newComment.userAvatar || '',
//                                 targetId: newComment.parentId,
//                                 targetType: 'review',
//                                 placeId: review.placeId,
//                                 reviewId: newComment.parentId,
//                                 commentId: commentId
//                             }
//                         );
//                     }
//                 }
                
//                 // Notify parent comment author about reply
//                 if (newComment.parentCommentId) {
//                     const parentCommentDoc = await db.collection('Comments').doc(newComment.parentCommentId).get();
//                     const parentComment = parentCommentDoc.data();
                    
//                     if (parentComment && newComment.userId !== parentComment.userId) {
//                         await sendAndLogNotification(
//                             parentComment.userId,
//                             'New Reply to Your Comment',
//                             `${newComment.userName || 'Someone'} replied to your comment`,
//                             'comment_replied',
//                             {
//                                 senderId: newComment.userId,
//                                 senderName: newComment.userName || 'User',
//                                 senderAvatar: newComment.userAvatar || '',
//                                 targetId: newComment.parentCommentId,
//                                 targetType: 'comment',
//                                 placeId: parentComment.placeId,
//                                 commentId: commentId,
//                                 parentCommentId: newComment.parentCommentId
//                             }
//                         );
//                     }
//                 }
//             }
//         });
//     }, err => {
//         console.error('[Listener Error] New Comments:', err);
//     });
// }

// // 4. Listener for new followers
// const userFollowersCache = {};

// function setupNewFollowerListener() {
//     console.log('[Listener] Setting up listener for new followers...');
    
//     db.collection('Users').onSnapshot(snapshot => {
//         snapshot.docChanges().forEach(async change => {
//             if (change.type === 'modified') {
//                 const userId = change.doc.id;
//                 const newUserData = change.doc.data();
//                 const oldUserData = change.doc.previous?.data?.() || {};
                
//                 const newFollowers = newUserData.followers || [];
//                 const oldFollowers = oldUserData.followers || [];
                
//                 // Check if followers count changed
//                 if (newFollowers.length > oldFollowers.length) {
//                     // Find the new follower
//                     const newFollowerId = newFollowers.find(follower => !oldFollowers.includes(follower));
                    
//                     if (newFollowerId && newFollowerId !== userId) {
//                         // Get follower info
//                         const followerDoc = await db.collection('Users').doc(newFollowerId).get();
//                         const followerData = followerDoc.data();
                        
//                         await sendAndLogNotification(
//                             userId,
//                             'New Follower',
//                             `${followerData?.name || 'Someone'} started following you`,
//                             'new_follower',
//                             {
//                                 senderId: newFollowerId,
//                                 senderName: followerData?.name || 'User',
//                                 senderAvatar: followerData?.avatar || '',
//                                 targetId: newFollowerId,
//                                 targetType: 'user'
//                             }
//                         );
//                     }
//                 }
                
//                 // Update cache
//                 userFollowersCache[userId] = newFollowers.length;
//             }
//         });
//     }, err => {
//         console.error('[Listener Error] New Followers:', err);
//     });
// }

// // Health check endpoints
// app.get('/health', (req, res) => {
//     res.status(200).json({ 
//         status: 'OK', 
//         timestamp: new Date().toISOString(),
//         service: 'Place Review Notification Server'
//     });
// });

// app.get('/ping', (req, res) => {
//     res.status(200).send('Server is awake!');
// });

// app.get('/', (req, res) => {
//     res.send('Place Review Notification Server is running!');
// });

// // Test endpoint for Firestore connection
// app.get('/test-firestore', async (req, res) => {
//     try {
//         console.log('=== Testing Firestore Connection ===');
        
//         // List collections
//         const collections = await db.listCollections();
//         const collectionNames = collections.map(col => col.id);
        
//         // Test Users collection
//         const usersCount = await db.collection('Users').count().get();
        
//         const result = {
//             success: true,
//             firestore: 'connected',
//             projectId: admin.app().options.projectId,
//             collections: collectionNames,
//             usersCount: usersCount.data().count,
//             timestamp: new Date().toISOString()
//         };
        
//         res.json(result);
        
//     } catch (error) {
//         console.error('❌ Firestore test failed:', error);
//         res.status(500).json({
//             success: false,
//             error: error.message,
//             code: error.code
//         });
//     }
// });

// // Test notification endpoint
// app.post('/test-notification', async (req, res) => {
//     try {
//         const { userId } = req.body;
        
//         if (!userId) {
//             return res.status(400).json({
//                 success: false,
//                 error: 'Missing userId'
//             });
//         }
        
//         const success = await sendAndLogNotification(
//             userId,
//             'Test Notification',
//             'This is a test notification from the server',
//             'test_notification',
//             {
//                 test: 'true',
//                 timestamp: new Date().toISOString(),
//                 server: 'Place Review Notification Server'
//             }
//         );
        
//         if (success) {
//             res.status(200).json({
//                 success: true,
//                 message: 'Test notification sent successfully'
//             });
//         } else {
//             res.status(500).json({
//                 success: false,
//                 error: 'Failed to send test notification'
//             });
//         }
//     } catch (error) {
//         console.error('Test notification error:', error);
//         res.status(500).json({
//             success: false,
//             error: error.message
//         });
//     }
// });

// // Start server
// app.listen(PORT, HOST, () => {
//     const serverUrl = `http://${HOST}:${PORT}`;
//     console.log(`🚀 Place Review Notification Server running on ${serverUrl}`);
//     console.log(`📱 For Android Emulator, use: http://10.0.2.2:${PORT}`);
//     console.log('🔔 All notification listeners initialized');
    
//     // Initialize all listeners
//     setupNewReviewListener();
//     setupReviewLikeListener();
//     setupNewCommentListener();
//     setupNewFollowerListener();
// });
