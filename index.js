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



// Make sure this function exists in your server code:
function convertToStringValues(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      result[key] = '';
    } else if (typeof value === 'object') {
      // For objects and arrays, stringify them
      try {
        result[key] = JSON.stringify(value);
      } catch {
        result[key] = String(value);
      }
    } else if (typeof value === 'boolean') {
      // Convert boolean to string
      result[key] = value ? 'true' : 'false';
    } else if (typeof value === 'number') {
      // Convert number to string
      result[key] = value.toString();
    } else {
      // Already a string or other type
      result[key] = String(value);
    }
  }
  return result;
}

// And the removeUndefined function:
function removeUndefined(obj) {
    if (!obj || typeof obj !== 'object') return {};
    return Object.fromEntries(
        Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null)
    );
}







// Send and Save Notifications
async function sendAndLogNotification(recipientId, title, body, type, data = {}) {
    try {
        const userDoc = await db.collection('Users').doc(recipientId).get();
        const fcmToken = userDoc.data()?.fcmToken;

        if (!fcmToken) {
            console.warn(`[sendAndLogNotification] No FCM token for user ${recipientId}`);
            return false;
        }

        let senderAvatar = data.senderAvatar || '';
        const senderName = data.senderName || '';
        const targetId = data.targetId || '';
        const targetType = data.targetType || '';

        // Validate and clean avatar URL
        let hasAvatar = false;
        if (senderAvatar && senderAvatar.startsWith('http')) {
            // Ensure it's a direct image URL, not a page
            if (!senderAvatar.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i)) {
                console.warn(`[sendAndLogNotification] Avatar URL may not be a direct image: ${senderAvatar}`);
                // Try to use a fallback
                senderAvatar = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(senderName || 'User') + '&background=1C59A4&color=fff&size=200';
            }
            hasAvatar = true;
        } else if (senderAvatar === '') {
            // Generate a colored avatar with initials
            const initials = (senderName || 'U').charAt(0).toUpperCase();
            senderAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=1C59A4&color=fff&size=200&bold=true`;
            hasAvatar = true;
        }

        // Generate unique ID
        const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // WhatsApp-style notification
        const message = {
            token: fcmToken,
            notification: { 
                title: senderName || title,
                body: body,
                // iOS specific image - use smaller size
                ...(hasAvatar && { 
                    imageUrl: `${senderAvatar}${senderAvatar.includes('?') ? '&' : '?'}size=400x400`
                })
            },
            data: convertToStringValues({
                // Core fields
                type: type,
                recipientId: recipientId,
                notificationId: notificationId,
                
                // Sender info
                senderAvatar: senderAvatar,
                senderName: senderName,
                senderId: data.senderId || '',
                
                // Target info
                targetId: targetId,
                targetType: targetType,
                
                // Content
                title: title,
                body: body,
                
                // App color
                appColor: '#1C59A4',
                
                // Extra data
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
                    tag: notificationId,
                    // Only add image if we have a valid avatar
                    ...(hasAvatar && { image: `${senderAvatar}${senderAvatar.includes('?') ? '&' : '?'}w=400&h=400&fit=crop` }),
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1,
                        'mutable-content': hasAvatar ? 1 : 0,
                        subtitle: senderName,
                        category: 'MESSAGE_CATEGORY',
                    }
                },
                headers: {
                    'apns-priority': '10',
                    'apns-push-type': 'alert',
                },
                fcmOptions: {
                    imageUrl: hasAvatar ? `${senderAvatar}${senderAvatar.includes('?') ? '&' : '?'}w=400&h=400&fit=crop` : undefined,
                }
            }
        };

        console.log(`[sendAndLogNotification] Sending to ${recipientId}`);
        console.log(`[sendAndLogNotification] Avatar URL: ${senderAvatar}`);

        const response = await admin.messaging().send(message);
        console.log(`[sendAndLogNotification] ✅ Notification sent`);

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
            isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            delivered: true,
            fcmMessageId: response,
            data: removeUndefined(data),
        };

        await db.collection('Users')
            .doc(recipientId)
            .collection('Notifications')
            .doc(notificationId)
            .set(notificationDoc);

        console.log(`[sendAndLogNotification] ✅ Saved to Firestore`);
        
        return true;

    } catch (e) {
        console.error(`[sendAndLogNotification] ❌ Error:`, e.message);
        return false;
    }
}

// Fallback function without style/picture
async function sendSimpleNotification(recipientId, title, body, type, data = {}) {
    try {
        const userDoc = await db.collection('Users').doc(recipientId).get();
        const fcmToken = userDoc.data()?.fcmToken;

        if (!fcmToken) return false;

        const senderName = data.senderName || '';
        const initials = (senderName || 'U').charAt(0).toUpperCase();
        const systemAvatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=1C59A4&color=fff&size=256&bold=true&format=png`;

        const message = {
            token: fcmToken,
            notification: { 
                title: senderName || title,
                body: body,
                imageUrl: systemAvatarUrl
            },
            data: convertToStringValues({
                type: type,
                recipientId: recipientId,
                senderAvatar: systemAvatarUrl,
                senderName: senderName,
                ...data
            }),
            android: {
                priority: 'high',
                notification: {
                    channelId: 'reviews_channel',
                    color: '#1C59A4',
                    sound: 'default',
                    icon: systemAvatarUrl, // This shows circular avatar!
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

        await admin.messaging().send(message);
        console.log(`[sendSimpleNotification] ✅ Simple notification with avatar sent`);
        return true;
        
    } catch (e) {
        console.error(`[sendSimpleNotification] ❌ Error:`, e.message);
        return false;
    }
}








//-----------------------------
// --- API Endpoint to Register/Update FCM Token ---
app.post('/register-token', async (req, res) => {
    const { userId, fcmToken } = req.body;

    if (!userId || !fcmToken) {
        console.warn(`[API /register-token] Missing required fields: userId, fcmToken`);
        return res.status(400).json({ 
            success: false, 
            error: 'Missing required fields: userId, fcmToken' 
        });
    }

    try {
        await db.collection('Users').doc(userId).set({
            fcmToken: fcmToken,
            fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        console.log(`[API /register-token] FCM Token registered/updated for user ${userId}`);
        res.status(200).json({ 
            success: true, 
            message: 'FCM Token registered successfully.' 
        });
    } catch (e) {
        console.error(`[API /register-token] Error registering FCM token for ${userId}: ${e.message}`);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to register FCM token.' 
        });
    }
});

// --- API Endpoint to Manually Send Notification ---
app.post('/send-notification', async (req, res) => {
    const { toUserId, type, title, body, senderName, senderAvatar, targetId, targetType, extraData = {} } = req.body;

    if (!toUserId || !type || !title || !body) {
        console.warn(`[API /send-notification] Missing required fields`);
        return res.status(400).json({ 
            success: false, 
            error: 'Missing required fields: toUserId, type, title, body' 
        });
    }

    try {
        console.log(`[API /send-notification] Sending notification to user ${toUserId}`);
        console.log(`[API /send-notification] Type: ${type}, Title: ${title}`);
        
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
                error: 'Failed to send notification. Check server logs for details.' 
            });
        }
    } catch (error) {
        console.error(`[API /send-notification] Error: ${error.message}`);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error',
            details: error.message
        });
    }
});

// --- Firestore Listeners for Real-Time Events ---

// 1. Listener for new reviews
function setupNewReviewListener() {
    console.log('[Listener] Setting up listener for new reviews...');
    
    db.collection('Reviews').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'added') {
                const newReview = change.doc.data();
                const reviewId = change.doc.id;
                
                console.log(`[Listener] New review added: ${reviewId} for place: ${newReview.placeId}`);
                
                // Notify place owner about new review
                if (newReview.userId && newReview.placeOwnerId && newReview.userId !== newReview.placeOwnerId) {
                    await sendAndLogNotification(
                        newReview.placeOwnerId,
                        'New Review on Your Place',
                        `${newReview.userName || 'Someone'} reviewed your place`,
                        'new_review',
                        {
                            senderId: newReview.userId,
                            senderName: newReview.userName || 'User',
                            senderAvatar: newReview.userAvatar || '',
                            targetId: newReview.placeId,
                            targetType: 'place',
                            placeId: newReview.placeId,
                            reviewId: reviewId,
                            rating: String(newReview.rating || 0),
                            reviewText: newReview.reviewText?.substring(0, 100) || ''
                        }
                    );
                }
            }
        });
    }, err => {
        console.error('[Listener Error] New Reviews:', err);
    });
}

// 2. Listener for review likes
const reviewLikesCache = {};

function setupReviewLikeListener() {
    console.log('[Listener] Setting up listener for review likes...');
    
    db.collection('Reviews').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'modified') {
                const reviewId = change.doc.id;
                const newReview = change.doc.data();
                const oldReview = change.doc.previous?.data?.() || {};
                
                const newLikes = newReview.likes || [];
                const oldLikes = oldReview.likes || [];
                
                // Check if likes count changed
                if (newLikes.length > oldLikes.length) {
                    // Find the new liker
                    const newLikerId = newLikes.find(like => !oldLikes.includes(like));
                    
                    if (newLikerId && newLikerId !== newReview.userId) {
                        // Get liker info
                        const likerDoc = await db.collection('Users').doc(newLikerId).get();
                        const likerData = likerDoc.data();
                        
                        await sendAndLogNotification(
                            newReview.userId,
                            'Your Review Got Liked',
                            `${likerData?.name || 'Someone'} liked your review`,
                            'review_liked',
                            {
                                senderId: newLikerId,
                                senderName: likerData?.name || 'User',
                                senderAvatar: likerData?.avatar || '',
                                targetId: reviewId,
                                targetType: 'review',
                                placeId: newReview.placeId,
                                reviewId: reviewId,
                                likeCount: String(newLikes.length)
                            }
                        );
                    }
                }
                
                // Update cache
                reviewLikesCache[reviewId] = newLikes.length;
            }
        });
    }, err => {
        console.error('[Listener Error] Review Likes:', err);
    });
}

// 3. Listener for new comments
function setupNewCommentListener() {
    console.log('[Listener] Setting up listener for new comments...');
    
    db.collection('Comments').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'added') {
                const newComment = change.doc.data();
                const commentId = change.doc.id;
                
                console.log(`[Listener] New comment added: ${commentId}`);
                
                // Notify review author if comment is on their review
                if (newComment.parentType === 'review') {
                    const reviewDoc = await db.collection('Reviews').doc(newComment.parentId).get();
                    const review = reviewDoc.data();
                    
                    if (review && newComment.userId !== review.userId) {
                        await sendAndLogNotification(
                            review.userId,
                            'New Comment on Your Review',
                            `${newComment.userName || 'Someone'} commented on your review`,
                            'new_comment',
                            {
                                senderId: newComment.userId,
                                senderName: newComment.userName || 'User',
                                senderAvatar: newComment.userAvatar || '',
                                targetId: newComment.parentId,
                                targetType: 'review',
                                placeId: review.placeId,
                                reviewId: newComment.parentId,
                                commentId: commentId
                            }
                        );
                    }
                }
                
                // Notify parent comment author about reply
                if (newComment.parentCommentId) {
                    const parentCommentDoc = await db.collection('Comments').doc(newComment.parentCommentId).get();
                    const parentComment = parentCommentDoc.data();
                    
                    if (parentComment && newComment.userId !== parentComment.userId) {
                        await sendAndLogNotification(
                            parentComment.userId,
                            'New Reply to Your Comment',
                            `${newComment.userName || 'Someone'} replied to your comment`,
                            'comment_replied',
                            {
                                senderId: newComment.userId,
                                senderName: newComment.userName || 'User',
                                senderAvatar: newComment.userAvatar || '',
                                targetId: newComment.parentCommentId,
                                targetType: 'comment',
                                placeId: parentComment.placeId,
                                commentId: commentId,
                                parentCommentId: newComment.parentCommentId
                            }
                        );
                    }
                }
            }
        });
    }, err => {
        console.error('[Listener Error] New Comments:', err);
    });
}

// 4. Listener for new followers
const userFollowersCache = {};

function setupNewFollowerListener() {
    console.log('[Listener] Setting up listener for new followers...');
    
    db.collection('Users').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'modified') {
                const userId = change.doc.id;
                const newUserData = change.doc.data();
                const oldUserData = change.doc.previous?.data?.() || {};
                
                const newFollowers = newUserData.followers || [];
                const oldFollowers = oldUserData.followers || [];
                
                // Check if followers count changed
                if (newFollowers.length > oldFollowers.length) {
                    // Find the new follower
                    const newFollowerId = newFollowers.find(follower => !oldFollowers.includes(follower));
                    
                    if (newFollowerId && newFollowerId !== userId) {
                        // Get follower info
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
                
                // Update cache
                userFollowersCache[userId] = newFollowers.length;
            }
        });
    }, err => {
        console.error('[Listener Error] New Followers:', err);
    });
}

// Health check endpoints
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'Place Review Notification Server'
    });
});

app.get('/ping', (req, res) => {
    res.status(200).send('Server is awake!');
});

app.get('/', (req, res) => {
    res.send('Place Review Notification Server is running!');
});

// Test endpoint for Firestore connection
app.get('/test-firestore', async (req, res) => {
    try {
        console.log('=== Testing Firestore Connection ===');
        
        // List collections
        const collections = await db.listCollections();
        const collectionNames = collections.map(col => col.id);
        
        // Test Users collection
        const usersCount = await db.collection('Users').count().get();
        
        const result = {
            success: true,
            firestore: 'connected',
            projectId: admin.app().options.projectId,
            collections: collectionNames,
            usersCount: usersCount.data().count,
            timestamp: new Date().toISOString()
        };
        
        res.json(result);
        
    } catch (error) {
        console.error('❌ Firestore test failed:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            code: error.code
        });
    }
});

// Test notification endpoint
app.post('/test-notification', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'Missing userId'
            });
        }
        
        const success = await sendAndLogNotification(
            userId,
            'Test Notification',
            'This is a test notification from the server',
            'test_notification',
            {
                test: 'true',
                timestamp: new Date().toISOString(),
                server: 'Place Review Notification Server'
            }
        );
        
        if (success) {
            res.status(200).json({
                success: true,
                message: 'Test notification sent successfully'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to send test notification'
            });
        }
    } catch (error) {
        console.error('Test notification error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Start server
app.listen(PORT, HOST, () => {
    const serverUrl = `http://${HOST}:${PORT}`;
    console.log(`🚀 Place Review Notification Server running on ${serverUrl}`);
    console.log(`📱 For Android Emulator, use: http://10.0.2.2:${PORT}`);
    console.log('🔔 All notification listeners initialized');
    
    // Initialize all listeners
    setupNewReviewListener();
    setupReviewLikeListener();
    setupNewCommentListener();
    setupNewFollowerListener();
});


//-------------------------------------
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

// // Helper function to remove undefined values
// function removeUndefined(obj) {
//     if (!obj || typeof obj !== 'object') return {};
//     return Object.fromEntries(
//         Object.entries(obj).filter(([_, v]) => v !== undefined)
//     );
// }

// // Main notification sending function (similar to child vaccination app)
// async function sendAndLogNotification(recipientId, title, body, type, data = {}) {
//     // Validate recipientId
//     if (!recipientId || typeof recipientId !== 'string' || recipientId.trim() === '') {
//         console.warn(`[sendAndLogNotification] recipientId is invalid: ${recipientId}`);
//         return false;
//     }

//     try {
//         // Get user's FCM token from Users collection
//         const userDoc = await db.collection('Users').doc(recipientId).get();
//         const userData = userDoc.data();
//         const fcmToken = userData?.fcmToken;

//         console.log(`[sendAndLogNotification] Fetched FCM token for user ${recipientId}: ${fcmToken ? 'Exists' : 'NOT FOUND'}`);

//         if (!fcmToken) {
//             console.warn(`[sendAndLogNotification] FCM token not found for user ${recipientId}. Cannot send notification.`);
//             return false;
//         }

//         // Convert all data values to strings for FCM
//         const stringData = {};
//         Object.entries({
//             type: type,
//             recipientId: recipientId,
//             ...data
//         }).forEach(([key, value]) => {
//             if (value !== undefined && value !== null) {
//                 stringData[key] = String(value);
//             }
//         });

//         const message = {
//             token: fcmToken,
//             notification: { title, body },
//             data: stringData,
//             android: {
//                 priority: 'high',
//             },
//             apns: {
//                 payload: {
//                     aps: {
//                         sound: 'default',
//                         badge: 1,
//                     },
//                 },
//             },
//         };

//         await admin.messaging().send(message);
//         console.log(`[sendAndLogNotification] Notification sent successfully to user: ${recipientId}`);

//         // Clean data for Firestore
//         const cleanedData = removeUndefined(data);
        
//         // Create notification document
//         const notificationDoc = {
//             recipientId: recipientId,
//             title: title,
//             body: body,
//             type: type,
//             data: cleanedData,
//             isRead: false,
//             timestamp: admin.firestore.FieldValue.serverTimestamp(),
//             ...(data.senderId && { senderId: data.senderId }),
//             ...(data.senderName && { senderName: data.senderName }),
//             ...(data.senderAvatar && { senderAvatar: data.senderAvatar }),
//             ...(data.targetId && { targetId: data.targetId }),
//             ...(data.targetType && { targetType: data.targetType }),
//         };

//         // Store in user's notifications subcollection
//         await db.collection('Users')
//             .doc(recipientId)
//             .collection('Notifications')
//             .add(notificationDoc);

//         console.log(`[sendAndLogNotification] Notification logged to Firestore for user ${recipientId}.`);
//         return true;

//     } catch (e) {
//         console.error(`[sendAndLogNotification] Error sending notification to ${recipientId}: ${e.message}`);
//         if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-argument') {
//             console.warn(`[sendAndLogNotification] FCM token for ${recipientId} is no longer valid. Attempting to remove from Firestore.`);
//             await db.collection('Users').doc(recipientId).update({ fcmToken: admin.firestore.FieldValue.delete() })
//                 .then(() => console.log(`[sendAndLogNotification] Invalid FCM token deleted for ${recipientId}`))
//                 .catch(deleteErr => console.error(`[sendAndLogNotification] Error deleting invalid FCM token for ${recipientId}: ${deleteErr.message}`));
//         }
//         return false;
//     }
// }

// // --- API Endpoint to Register/Update FCM Token ---
// app.post('/register-token', async (req, res) => {
//     const { userId, fcmToken } = req.body;

//     if (!userId || !fcmToken) {
//         console.warn(`[API /register-token] Missing required fields: userId, fcmToken`);
//         return res.status(400).send('Missing required fields: userId, fcmToken');
//     }

//     try {
//         await db.collection('Users').doc(userId).set({
//             fcmToken: fcmToken,
//             fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
//         }, { merge: true });
//         console.log(`[API /register-token] FCM Token registered/updated for user ${userId}`);
//         res.status(200).json({ success: true, message: 'FCM Token registered successfully.' });
//     } catch (e) {
//         console.error(`[API /register-token] Error registering FCM token for ${userId}: ${e.message}`);
//         res.status(500).json({ success: false, error: 'Failed to register FCM token.' });
//     }
// });

// // --- API Endpoint to Manually Send Notification ---
// app.post('/send-notification', async (req, res) => {
//     const { toUserId, type, title, body, senderName, senderAvatar, targetId, targetType, extraData } = req.body;

//     if (!toUserId || !type || !title || !body) {
//         console.warn(`[API /send-notification] Missing required fields`);
//         return res.status(400).json({ success: false, error: 'Missing required fields' });
//     }

//     const success = await sendAndLogNotification(toUserId, title, body, type, {
//         senderName,
//         senderAvatar,
//         targetId,
//         targetType,
//         ...extraData
//     });
    
//     if (success) {
//         res.status(200).json({ success: true, message: 'Notification sent and saved' });
//     } else {
//         res.status(500).json({ success: false, error: 'Failed to send notification. Check server logs for details.' });
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
//                             rating: newReview.rating,
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
//                                 likeCount: newLikes.length
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
//     res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
// });

// app.get('/ping', (req, res) => {
//     res.status(200).send('Server is awake!');
// });

// app.get('/', (req, res) => {
//     res.send('Place Review Notification Server is running!');
// });

// // Test endpoint
// app.get('/test', async (req, res) => {
//     try {
//         const collections = await db.listCollections();
//         const collectionNames = collections.map(col => col.id);
//         res.json({
//             status: 'Server is running',
//             firestoreCollections: collectionNames,
//             timestamp: new Date().toISOString()
//         });
//     } catch (error) {
//         res.status(500).json({ error: error.message });
//     }
// });

// // Start server
// app.listen(PORT, HOST, () => {
//     const serverUrl = `http://${HOST}:${PORT}`;
//     console.log(`Place Review Notification Server running on ${serverUrl}`);
//     console.log(`For Android Emulator, use: http://10.0.2.2:${PORT}`);
//     console.log('All notification listeners initialized');
    
//     // Initialize all listeners
//     setupNewReviewListener();
//     setupReviewLikeListener();
//     setupNewCommentListener();
//     setupNewFollowerListener();
// });


//--------------------------------
// // server/notifications-server.js
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

// // // Helper function to send and log notification
// // async function sendAndLogNotification(notificationData) {
// //   const {
// //     toUserId,
// //     type,
// //     title,
// //     body,
// //     senderName,
// //     senderAvatar,
// //     targetId,
// //     targetType,
// //     extraData = {}
// //   } = notificationData;

// //   try {
// //     // Get user's FCM token
// //     const userDoc = await db.collection('Users').doc(toUserId).get();
// //     const userData = userDoc.data();
// //     const fcmToken = userData?.fcmToken;

// //     if (!fcmToken) {
// //       console.warn(`No FCM token found for user ${toUserId}`);
// //       return false;
// //     }

// //     // Prepare FCM message
// //     const message = {
// //       token: fcmToken,
// //       notification: { title, body },
// //       data: {
// //         type,
// //         senderId: extraData.senderId || '',
// //         senderName,
// //         senderAvatar,
// //         targetId,
// //         targetType,
// //         placeId: extraData.placeId || '',
// //         reviewId: extraData.reviewId || '',
// //         commentId: extraData.commentId || '',
// //         ...extraData
// //       },
// //       android: {
// //         priority: 'high',
// //       },
// //       apns: {
// //         payload: {
// //           aps: {
// //             sound: 'default',
// //             badge: 1,
// //           },
// //         },
// //       },
// //     };

// //     // Send FCM message
// //     await admin.messaging().send(message);
// //     console.log(`Notification sent to user ${toUserId}: ${title}`);

// //     // Save to Firestore
// //     const notificationDoc = {
// //       type,
// //       title,
// //       body,
// //       senderId: extraData.senderId || '',
// //       senderName,
// //       senderAvatar,
// //       targetId,
// //       targetType,
// //       isRead: false,
// //       timestamp: admin.firestore.FieldValue.serverTimestamp(),
// //       extraData,
// //     };

// //     await db
// //       .collection('Users')
// //       .doc(toUserId)
// //       .collection('Notifications')
// //       .add(notificationDoc);

// //     console.log(`Notification saved to Firestore for user ${toUserId}`);
// //     return true;

// //   } catch (error) {
// //     console.error('Error sending notification:', error);
    
// //     // Handle invalid FCM tokens
// //     if (error.code === 'messaging/registration-token-not-registered') {
// //       console.warn(`Removing invalid FCM token for user ${toUserId}`);
// //       await db.collection('Users').doc(toUserId).update({
// //         fcmToken: admin.firestore.FieldValue.delete()
// //       });
// //     }
    
// //     return false;
// //   }
// // }

// async function sendAndLogNotification(notificationData) {
//   const {
//     toUserId,
//     type,
//     title,
//     body,
//     senderName,
//     senderAvatar,
//     targetId,
//     targetType,
//     extraData = {}
//   } = notificationData;

//   console.log('=== Starting Notification Process ===');
//   console.log('toUserId:', toUserId);
//   console.log('type:', type);
//   console.log('title:', title);

//   try {
//     // 1. Get user document
//     const userRef = db.collection('Users').doc(toUserId);
//     const userDoc = await userRef.get();
    
//     if (!userDoc.exists) {
//       console.error(`User ${toUserId} does not exist in Firestore`);
//       return false;
//     }
    
//     const userData = userDoc.data();
//     console.log('User data found:', userData ? 'Yes' : 'No');
//     console.log('User document:', JSON.stringify(userData, null, 2));
    
//     const fcmToken = userData?.fcmToken;
//     console.log('FCM Token:', fcmToken ? 'Exists' : 'MISSING!');

//     if (!fcmToken) {
//       console.warn(`No FCM token found for user ${toUserId}`);
//       return false;
//     }

//     // 2. Prepare FCM message
//     const message = {
//       token: fcmToken,
//       notification: { 
//         title: title || 'Notification',
//         body: body || 'You have a new notification'
//       },
//       data: {
//         type: type || 'general',
//         senderId: extraData.senderId || '',
//         senderName: senderName || 'User',
//         senderAvatar: senderAvatar || '',
//         targetId: targetId || '',
//         targetType: targetType || 'general',
//         placeId: extraData.placeId || '',
//         reviewId: extraData.reviewId || '',
//         commentId: extraData.commentId || '',
//         ...extraData
//       },
//       android: {
//         priority: 'high',
//       },
//       apns: {
//         payload: {
//           aps: {
//             sound: 'default',
//             badge: 1,
//           },
//         },
//       },
//     };

//     console.log('FCM Message prepared:', JSON.stringify(message, null, 2));

//     // 3. Send FCM message
//     console.log('Attempting to send FCM message...');
//     const fcmResponse = await admin.messaging().send(message);
//     console.log('FCM Response:', fcmResponse);
//     console.log(`✅ Notification sent to user ${toUserId}: ${title}`);

//     // 4. Save to Firestore
//     const notificationDoc = {
//       type,
//       title,
//       body,
//       senderId: extraData.senderId || '',
//       senderName,
//       senderAvatar,
//       targetId,
//       targetType,
//       isRead: false,
//       timestamp: admin.firestore.FieldValue.serverTimestamp(),
//       extraData,
//     };

//     console.log('Saving to Firestore...');
//     await db
//       .collection('Users')
//       .doc(toUserId)
//       .collection('Notifications')
//       .add(notificationDoc);

//     console.log(`✅ Notification saved to Firestore for user ${toUserId}`);
//     return true;

//   } catch (error) {
//     console.error('❌ Error in sendAndLogNotification:', error);
//     console.error('Error code:', error.code);
//     console.error('Error message:', error.message);
//     console.error('Error stack:', error.stack);
    
//     // Handle specific FCM errors
//     if (error.code === 'messaging/invalid-registration-token' || 
//         error.code === 'messaging/registration-token-not-registered') {
//       console.warn(`Removing invalid FCM token for user ${toUserId}`);
//       try {
//         await db.collection('Users').doc(toUserId).update({
//           fcmToken: admin.firestore.FieldValue.delete()
//         });
//         console.log(`Removed invalid token for user ${toUserId}`);
//       } catch (updateError) {
//         console.error('Error removing token:', updateError);
//       }
//     }
    
//     return false;
//   }
// }


// // API Endpoints

// // Send notification
// // app.post('/send-notification', async (req, res) => {
// //   try {
// //     const notificationData = req.body;
    
// //     const success = await sendAndLogNotification(notificationData);
    
// //     if (success) {
// //       res.status(200).json({ message: 'Notification sent successfully' });
// //     } else {
// //       res.status(500).json({ error: 'Failed to send notification' });
// //     }
// //   } catch (error) {
// //     console.error('Error in /send-notification:', error);
// //     res.status(500).json({ error: 'Internal server error' });
// //   }
// // });
// app.post('/send-notification', async (req, res) => {
//   try {
//     console.log('=== /send-notification Called ===');
//     console.log('Request body:', JSON.stringify(req.body, null, 2));
    
//     const notificationData = req.body;
    
//     // Validate required fields
//     const requiredFields = ['toUserId', 'type', 'title', 'body'];
//     const missingFields = requiredFields.filter(field => !notificationData[field]);
    
//     if (missingFields.length > 0) {
//       console.error('Missing required fields:', missingFields);
//       return res.status(400).json({ 
//         error: 'Missing required fields',
//         missingFields 
//       });
//     }
    
//     const success = await sendAndLogNotification(notificationData);
    
//     if (success) {
//       res.status(200).json({ 
//         message: 'Notification sent successfully',
//         success: true 
//       });
//     } else {
//       res.status(500).json({ 
//         error: 'Failed to send notification',
//         success: false 
//       });
//     }
//   } catch (error) {
//     console.error('❌ Error in /send-notification endpoint:', error);
//     console.error('Full error:', error.stack);
//     res.status(500).json({ 
//       error: 'Internal server error',
//       details: error.message,
//       success: false 
//     });
//   }
// });

// app.get('/test-firestore', async (req, res) => {
//   try {
//     console.log('=== Testing Firestore Connection ===');
    
//     // Test 1: Check db instance
//     console.log('1. Checking db instance...');
//     if (!db) {
//       return res.json({ success: false, error: 'Firestore db not initialized' });
//     }
//     console.log('✅ db instance exists');
    
//     // Test 2: List collections
//     console.log('2. Listing collections...');
//     const collections = await db.listCollections();
//     const collectionNames = collections.map(col => col.id);
//     console.log('✅ Collections:', collectionNames);
    
//     // Test 3: Try to read a document
//     console.log('3. Testing document read...');
//     const testRef = db.collection('test').doc('test');
//     const testDoc = await testRef.get();
//     console.log('✅ Can read documents');
    
//     // Test 4: Check specific user
//     const userId = 'oVsdr8OatSQFltu7CtqKTo4YQDj2';
//     console.log(`4. Checking user: ${userId}`);
    
//     // Try lowercase 'users'
//     const userRef = db.collection('Users').doc(userId);
//     const userDoc = await userRef.get();
    
//     const result = {
//       success: true,
//       firestore: 'connected',
//       projectId: admin.app().options.projectId,
//       collections: collectionNames,
//       testDocument: testDoc.exists ? 'exists' : 'does not exist',
//       userCheck: {
//         userId: userId,
//         collection: 'users',
//         exists: userDoc.exists,
//         data: userDoc.exists ? 'has data' : 'no data',
//         hasFcmToken: userDoc.exists && !!userDoc.data()?.fcmToken
//       }
//     };
    
//     res.json(result);
    
//   } catch (error) {
//     console.error('❌ Firestore test failed:', error);
//     res.status(500).json({
//       success: false,
//       error: error.message,
//       code: error.code,
//       stack: error.stack
//     });
//   }
// });
// // Register FCM token
// app.post('/register-token', async (req, res) => {
//   try {
//     const { userId, fcmToken } = req.body;

//     if (!userId || !fcmToken) {
//       return res.status(400).json({ error: 'Missing userId or fcmToken' });
//     }

//     await db.collection('Users').doc(userId).set({
//       fcmToken,
//       fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
//     }, { merge: true });

//     res.status(200).json({ message: 'FCM token registered successfully' });
//   } catch (error) {
//     console.error('Error registering FCM token:', error);
//     res.status(500).json({ error: 'Failed to register FCM token' });
//   }
// });

// // Firestore Listeners for Real-time Events

// // Listen for new reviews
// function setupNewReviewListener() {
//   console.log('Setting up new review listener...');
  
//   db.collection('Reviews').onSnapshot((snapshot) => {
//     snapshot.docChanges().forEach(async (change) => {
//       if (change.type === 'added') {
//         const review = change.doc.data();
//         const reviewId = change.doc.id;
        
//         // Notify place owner about new review
//         await sendAndLogNotification({
//           toUserId: review.placeOwnerId,
//           type: 'new_review',
//           title: 'New Review on Your Place',
//           body: `${review.userName} reviewed "${review.placeName}"`,
//           senderName: review.userName,
//           senderAvatar: review.userAvatar,
//           targetId: review.placeId,
//           targetType: 'place',
//           extraData: {
//             senderId: review.userId,
//             placeId: review.placeId,
//             reviewId: reviewId,
//             rating: review.rating,
//             reviewText: review.reviewText,
//           },
//         });
//       }
//     });
//   });
// }

// // Listen for review likes
// function setupReviewLikeListener() {
//   console.log('Setting up review like listener...');
  
//   db.collection('Reviews').onSnapshot((snapshot) => {
//     snapshot.docChanges().forEach(async (change) => {
//       if (change.type === 'modified') {
//         const review = change.doc.data();
//         const reviewId = change.doc.id;
//         const oldReview = change.doc.previous.data();
        
//         // Check if likes count increased
//         const newLikes = review.likes || [];
//         const oldLikes = oldReview?.likes || [];
        
//         if (newLikes.length > oldLikes.length) {
//           const newLikeUserId = newLikes.find(like => !oldLikes.includes(like));
          
//           if (newLikeUserId && newLikeUserId !== review.userId) {
//             // Get liker's info
//             const likerDoc = await db.collection('Users').doc(newLikeUserId).get();
//             const likerData = likerDoc.data();
            
//             await sendAndLogNotification({
//               toUserId: review.userId,
//               type: 'review_liked',
//               title: 'Your Review Got Liked',
//               body: `${likerData?.name || 'Someone'} liked your review`,
//               senderName: likerData?.name || 'User',
//               senderAvatar: likerData?.avatar || '',
//               targetId: reviewId,
//               targetType: 'review',
//               extraData: {
//                 senderId: newLikeUserId,
//                 placeId: review.placeId,
//                 reviewId: reviewId,
//                 likeCount: newLikes.length,
//               },
//             });
//           }
//         }
//       }
//     });
//   });
// }

// // Listen for new comments
// function setupNewCommentListener() {
//   console.log('Setting up new comment listener...');
  
//   db.collection('Comments').onSnapshot((snapshot) => {
//     snapshot.docChanges().forEach(async (change) => {
//       if (change.type === 'added') {
//         const comment = change.doc.data();
//         const commentId = change.doc.id;
        
//         // Notify review author about new comment
//         if (comment.parentType === 'review') {
//           const reviewDoc = await db.collection('Reviews').doc(comment.parentId).get();
//           const review = reviewDoc.data();
          
//           if (review && comment.userId !== review.userId) {
//             await sendAndLogNotification({
//               toUserId: review.userId,
//               type: 'new_comment',
//               title: 'New Comment on Your Review',
//               body: `${comment.userName} commented on your review`,
//               senderName: comment.userName,
//               senderAvatar: comment.userAvatar,
//               targetId: comment.parentId,
//               targetType: 'review',
//               extraData: {
//                 senderId: comment.userId,
//                 placeId: review.placeId,
//                 reviewId: comment.parentId,
//                 commentId: commentId,
//               },
//             });
//           }
//         }
        
//         // Notify parent comment author about reply
//         if (comment.parentCommentId) {
//           const parentCommentDoc = await db.collection('Comments').doc(comment.parentCommentId).get();
//           const parentComment = parentCommentDoc.data();
          
//           if (parentComment && comment.userId !== parentComment.userId) {
//             await sendAndLogNotification({
//               toUserId: parentComment.userId,
//               type: 'comment_replied',
//               title: 'New Reply to Your Comment',
//               body: `${comment.userName} replied to your comment`,
//               senderName: comment.userName,
//               senderAvatar: comment.userAvatar,
//               targetId: comment.parentCommentId,
//               targetType: 'comment',
//               extraData: {
//                 senderId: comment.userId,
//                 placeId: comment.placeId,
//                 commentId: commentId,
//                 parentCommentId: comment.parentCommentId,
//               },
//             });
//           }
//         }
//       }
//     });
//   });
// }

// // Listen for new followers
// function setupNewFollowerListener() {
//   console.log('Setting up new follower listener...');
  
//   db.collection('Users').onSnapshot((snapshot) => {
//     snapshot.docChanges().forEach(async (change) => {
//       if (change.type === 'modified') {
//         const user = change.doc.data();
//         const userId = change.doc.id;
//         const oldUser = change.doc.previous.data();
        
//         // Check if followers count increased
//         const newFollowers = user.followers || [];
//         const oldFollowers = oldUser?.followers || [];
        
//         if (newFollowers.length > oldFollowers.length) {
//           const newFollowerId = newFollowers.find(follower => !oldFollowers.includes(follower));
          
//           if (newFollowerId) {
//             // Get follower's info
//             const followerDoc = await db.collection('Users').doc(newFollowerId).get();
//             const followerData = followerDoc.data();
            
//             await sendAndLogNotification({
//               toUserId: userId,
//               type: 'new_follower',
//               title: 'New Follower',
//               body: `${followerData?.name || 'Someone'} started following you`,
//               senderName: followerData?.name || 'User',
//               senderAvatar: followerData?.avatar || '',
//               targetId: newFollowerId,
//               targetType: 'user',
//               extraData: {
//                 senderId: newFollowerId,
//               },
//             });
//           }
//         }
//       }
//     });
//   });
// }

// // Health check endpoint
// app.get('/health', (req, res) => {
//   res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
// });

// app.get('/ping', (req, res) => {
//   res.status(200).send('Server is awake!');
// });

// // --- Root Endpoint ---
// app.get('/', (req, res) => {
//     res.send('Place Review Backend is running!');
// });

// // Start server
// app.listen(PORT,HOST, () => {
//    const serverUrl = `http://${HOST}:${PORT}`;
//   console.log(`Node.js Server running on http://${HOST}:${PORT}`);
//   console.log(`Access your API at: ${serverUrl}`);
//   console.log(`(For Android Emulator, use: http://10.0.2.2:${PORT})`);
//   console.log(`Reviews App Notification Server running on port ${PORT}`);

//   // Initialize listeners
//   setupNewReviewListener();
//   setupReviewLikeListener();
//   setupNewCommentListener();
//   setupNewFollowerListener();
  
//   console.log('All notification listeners initialized');
// });
